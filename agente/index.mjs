import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const port = Number(process.env.AGENT_PORT || 7300);
const mcpUrl = process.env.MCP_URL || 'http://127.0.0.1:7301/mcp';
const publicUrl = process.env.AGENT_URL || `http://127.0.0.1:${port}`;
const tasks = new Map();
// Dados privados da ponte: nunca fazem parte do objeto Task enviado ao cliente.
const bridges = new Map();
let connection;
async function connect(traceparent) {
  if (!connection) connection = (async () => {
    const client = new Client({ name: 'agente-central-de-salas', version: '1.0.0' }, {
      capabilities: { elicitation: { form: {} } }, versionNegotiation: { mode: { pin: '2026-07-28' } }, inputRequired: { autoFulfill: false }
    });
    await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), {
      // A descoberta inicial tambem pertence ao trace da primeira Task.
      fetch: (url, init) => {
        if (traceparent && typeof init?.body === 'string') {
          const rpc = JSON.parse(init.body);
          if (rpc.method === 'server/discover') {
            rpc.params._meta.traceparent = traceparent;
            init = { ...init, body: JSON.stringify(rpc) };
          }
        }
        return fetch(url, init);
      }
    }));
    return client;
  })().catch(e => { connection = undefined; throw e; });
  return connection;
}
// request() preserva input_required; callTool() 2.3.1 valida outputSchema antes de distinguir a pausa.
const callTool = (client, params) => client.request({ method: 'tools/call', params }, { allowInputRequired: true });
const meta = traceparent => traceparent ? { traceparent } : {};
function status(task, state, text) {
  task.status = { state: `TASK_STATE_${state}`, timestamp: new Date().toISOString() };
  if (text !== undefined) {
    const message = { messageId: randomUUID(), role: 'ROLE_AGENT', taskId: task.id, contextId: task.contextId, parts: [{ text }] };
    task.status.message = message; task.history.push(message);
  }
}
function alternatives(task, bridge) { status(task, 'INPUT_REQUIRED', `alternativas: ${bridge.alternativas.join(', ')}`); }
async function applyResult(task, bridge, result) {
  if (result.resultType === 'input_required') {
    const entries = Object.entries(result.inputRequests || {});
    if (entries.length !== 1) throw new Error('Resposta MCP sem uma unica pergunta');
    const [key, request] = entries[0];
    const field = request.params.requestedSchema.properties.sala;
    Object.assign(bridge, { key, requestState: result.requestState, alternativas: field.enum || [field.const] });
    bridges.set(task.id, bridge);
    alternatives(task, bridge); // Aqui o input_required MCP pausa a Task A2A.
    return;
  }
  if (result.isError) {
    status(task, 'FAILED', result.content.filter(p => p.type === 'text').map(p => p.text).join('\n'));
  } else if (result.structuredContent?.reservado === false) {
    status(task, 'CANCELED', result.structuredContent.motivo);
  } else {
    const data = { ...result.structuredContent, politica: bridge.politica };
    task.artifacts.push({ artifactId: randomUUID(), name: 'reserva', parts: [{ text: JSON.stringify(data) }] });
    status(task, 'COMPLETED', `Reserva ${data.reserva} confirmada na ${data.sala}.`);
  }
  bridges.delete(task.id);
}
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
async function send(message, traceparent) {
  if (!message || !Array.isArray(message.parts)) fail(-32602, 'message.parts obrigatorio');
  const text = message.parts.map(p => p.text || '').join(' ');
  let task, bridge;
  if (message.taskId) {
    task = tasks.get(message.taskId);
    if (!task) fail(-32001, 'Task inexistente');
    if (task.status.state !== 'TASK_STATE_INPUT_REQUIRED') fail(-32602, 'Task nao aceita continuacao no estado atual');
    bridge = bridges.get(task.id);
    task.history.push(message);
    const choice = /^escolha=(\S+)$/.exec(text)?.[1];
    if (choice !== 'recusar' && !bridge.alternativas.includes(choice)) { alternatives(task, bridge); return task; }
    status(task, 'WORKING');
    try {
      const client = await connect(bridge.traceparent);
      // O SDK emite um id novo; o estado opaco e a chave sao ecoados sem alteracao.
      const result = await callTool(client, { name: bridge.tool, arguments: bridge.args, requestState: bridge.requestState,
        inputResponses: { [bridge.key]: choice === 'recusar' ? { action: 'decline' } : { action: 'accept', content: { sala: choice } } },
        _meta: meta(bridge.traceparent) });
      await applyResult(task, bridge, result);
    } catch (e) { status(task, 'FAILED', e.message); bridges.delete(task.id); }
    return task;
  }
  const match = /^reservar sala=(\S+) inicio=(\S+) fim=(\S+) responsavel=(.+)$/.exec(text);
  if (!match) fail(-32602, 'Use reservar sala=<id> inicio=<iso8601> fim=<iso8601> responsavel=<nome>');
  task = { id: randomUUID(), contextId: randomUUID(), status: {}, history: [message], artifacts: [] };
  tasks.set(task.id, task); status(task, 'SUBMITTED');
  bridge = { traceparent, args: { sala: match[1], inicio: match[2], fim: match[3], responsavel: match[4] } };
  status(task, 'WORKING');
  try {
    const client = await connect(traceparent);
    const listing = await client.listTools({ _meta: meta(traceparent) }, { cacheMode: 'refresh' });
    // A acao fixa do produto seleciona uma ferramenta anunciada em runtime.
    const tool = listing.tools.find(t => t.name === 'reservar_sala');
    if (!tool) throw new Error('Servidor nao anunciou a capacidade de reserva');
    bridge.tool = tool.name;
    const resource = await client.readResource({ uri: 'politica://uso', _meta: meta(traceparent) }, { cacheMode: 'refresh' });
    bridge.politica = /^versao:\s*(.+)$/m.exec(resource.contents[0].text)?.[1];
    if (!bridge.politica) throw new Error('Resource sem versao de politica');
    const result = await callTool(client, { name: bridge.tool, arguments: bridge.args, _meta: meta(traceparent) });
    await applyResult(task, bridge, result);
  } catch (e) { status(task, 'FAILED', e.message); bridges.delete(task.id); }
  return task;
}
const card = { name: 'Central de Salas', description: 'Reserva salas de reuniao da Hill Valley Tech.', version: '1.0.0',
  provider: { organization: 'Hill Valley Tech', url: 'https://hillvalley.example' },
  supportedInterfaces: [{ url: `${publicUrl}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
  capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false }, defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'],
  skills: [{ id: 'reservar-sala', name: 'Reservar sala', description: 'Reserva uma sala e pede alternativa em caso de conflito.', tags: ['salas', 'agenda'], inputModes: ['text/plain'], outputModes: ['text/plain'], examples: ['reservar sala=sala-garagem inicio=2026-11-03T14:00:00-03:00 fim=2026-11-03T15:00:00-03:00 responsavel=Marty'] }] };
createServer(async (req, res) => {
  const respond = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.method === 'GET' && req.url === '/.well-known/agent-card.json') return respond(200, card);
  if (req.method !== 'POST' || req.url !== '/a2a') return respond(404, { error: 'Not found' });
  let rpc;
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    try { rpc = JSON.parse(Buffer.concat(chunks).toString()); } catch { fail(-32700, 'Parse error'); }
    if (rpc.jsonrpc !== '2.0' || !rpc.params) fail(-32600, 'Invalid Request');
    let task;
    if (rpc.method === 'SendMessage') task = await send(rpc.params.message, req.headers.traceparent);
    else if (rpc.method === 'GetTask') { task = tasks.get(rpc.params.id); if (!task) fail(-32001, 'Task inexistente'); }
    else fail(-32601, 'Method not found');
    respond(200, { jsonrpc: '2.0', id: rpc.id, result: { task } });
  } catch (e) { respond(200, { jsonrpc: '2.0', id: rpc?.id ?? null, error: { code: e.code || -32603, message: e.message } }); }
}).listen(port, '127.0.0.1', () => console.error(`A2A em ${publicUrl}/a2a`));
