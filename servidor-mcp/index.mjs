import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { McpServer, createMcpHandler, createRequestStateCodec, inputRequired, ProtocolError } from '@modelcontextprotocol/server';

const secret = process.env.REQUEST_STATE_SECRET;
if (!secret || !/^[a-fA-F0-9]{64,}$/.test(secret) || secret.length % 2) {
  throw new Error('REQUEST_STATE_SECRET deve conter pelo menos 32 bytes em hexadecimal. Consulte o README.');
}
const codec = createRequestStateCodec({ key: Buffer.from(secret, 'hex'), ttlSeconds: 600,
  bind: ctx => ctx.mcpReq.method });
const load = name => readFileSync(new URL(`../dados/${name}`, import.meta.url), 'utf8');
const salas = JSON.parse(load('salas.json'));
const reservas = JSON.parse(load('reservas.json'));
const politica = load('politica-de-uso.md');
const versao = politica.split('\n')[0].split(':')[1].trim();
const intervalo = z.object({ sala: z.string(), inicio: z.string(), fim: z.string() });
const pedido = intervalo.extend({ responsavel: z.string().min(1) });
const salaSchema = z.object({ id: z.string(), nome: z.string(), capacidade: z.number().int(), recursos: z.array(z.string()) });
const reservaSchema = z.object({ reserva: z.string().optional(), reservado: z.boolean(), sala: z.string().optional(), inicio: z.string().optional(), fim: z.string().optional(), responsavel: z.string().optional(), politica: z.string().optional(), motivo: z.string().optional() });
const result = structuredContent => ({ content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent });
function validar(a) {
  const sala = salas.find(s => s.id === a.sala);
  if (!sala) throw new Error(`Sala inexistente: ${a.sala}`);
  const inicio = Date.parse(a.inicio), fim = Date.parse(a.fim);
  if (!Number.isFinite(inicio) || !Number.isFinite(fim) || fim <= inicio) throw new Error('Intervalo invalido: fim deve ser posterior a inicio');
  const local = n => new Date(n - 3 * 3600000).toISOString();
  const i = local(inicio), f = local(fim);
  if (i.slice(0,10) !== f.slice(0,10) || i.slice(11,23) < '08:00:00.000' || f.slice(11,23) > '20:00:00.000') throw new Error('Fora da janela de uso: a politica permite reservas entre 08:00 e 20:00');
  if (fim - inicio > 7200000) throw new Error('Duracao acima do limite: a politica permite no maximo 2 horas');
  return sala;
}
const conflitos = a => reservas.filter(r => r.sala === a.sala && Date.parse(r.inicio) < Date.parse(a.fim) && Date.parse(r.fim) > Date.parse(a.inicio));
function criar(a) {
  const id = `res-${String(reservas.length + 1).padStart(4, '0')}`;
  reservas.push({ id, ...a });
  return result({ reserva: id, reservado: true, ...a, politica: versao });
}
function factory() {
  const server = new McpServer({ name: 'central-de-salas', version: '1.0.0' }, { capabilities: { tools: {}, resources: {} }, requestState: { verify: codec.verify } });
  server.registerResource('politica', 'politica://uso', { mimeType: 'text/markdown' }, async uri => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: politica }] }));
  server.registerTool('listar_salas', { description: 'Lista as salas.', inputSchema: z.object({}), outputSchema: z.object({ salas: z.array(salaSchema) }) }, async () => result({ salas }));
  server.registerTool('consultar_disponibilidade', { description: 'Consulta disponibilidade no intervalo.', inputSchema: intervalo, outputSchema: z.object({ sala: z.string(), livre: z.boolean(), conflitos: z.array(z.object({ id: z.string(), sala: z.string(), inicio: z.string(), fim: z.string(), responsavel: z.string() })) }) }, async a => {
    validar(a); const c = conflitos(a); return result({ sala: a.sala, livre: c.length === 0, conflitos: c });
  });
  server.registerTool('reservar_sala', { description: 'Reserva uma sala ou solicita alternativa.', inputSchema: pedido, outputSchema: reservaSchema }, async (args, ctx) => {
    const state = ctx.mcpReq.requestState();
    if (state !== undefined) {
      if (state.tool !== 'reservar_sala') throw new ProtocolError(-32602, 'Estado de outra ferramenta');
      const resposta = ctx.mcpReq.inputResponses?.[state.key];
      if (resposta?.action === 'decline' || resposta?.action === 'cancel') return result({ reservado: false, motivo: 'recusado' });
      if (resposta?.action !== 'accept' || !state.alternativas.includes(resposta.content?.sala)) throw new ProtocolError(-32602, 'Escolha invalida');
      const a = { ...state.args, sala: resposta.content.sala };
      validar(a);
      if (conflitos(a).length) throw new Error('Sem alternativas disponiveis no intervalo');
      return criar(a);
    }
    const sala = validar(args);
    if (!conflitos(args).length) return criar(args);
    const alternativas = salas.filter(s => s.capacidade >= sala.capacidade && !conflitos({ ...args, sala: s.id }).length)
      .sort((a, b) => a.capacidade - b.capacidade || a.id.localeCompare(b.id)).slice(0, 3).map(s => s.id);
    if (!alternativas.length) throw new Error('Sem alternativas disponiveis no intervalo');
    const key = randomUUID();
    return inputRequired({ requestState: await codec.mint({ tool: 'reservar_sala', args, alternativas, key }, ctx), inputRequests: {
      [key]: inputRequired.elicit({ mode: 'form', message: 'A sala pedida esta ocupada nesse intervalo. Escolha uma alternativa.', requestedSchema: { type: 'object', properties: { sala: { type: 'string', enum: alternativas } }, required: ['sala'] } })
    } });
  });
  return server;
}
const handler = createMcpHandler(factory, { legacy: 'reject', responseMode: 'json', onerror: e => console.error(e.message) });
const port = Number(process.env.MCP_PORT || 7301);
const http = createServer(async (req, res) => {
  try {
    if (req.url !== '/mcp') { res.writeHead(404).end(); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    let rpc; try { rpc = body ? JSON.parse(body) : undefined; } catch { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })); return; }
    console.error(JSON.stringify({ method: rpc?.method, id: rpc?.id, traceparent: rpc?.params?._meta?.traceparent ?? null }));
    if (rpc) {
      const meta = rpc.params?._meta;
      if (!meta || !Object.hasOwn(meta, 'io.modelcontextprotocol/protocolVersion') || !Object.hasOwn(meta, 'io.modelcontextprotocol/clientCapabilities')) {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id ?? null, error: { code: -32602, message: 'Metadados obrigatorios ausentes' } })); return;
      }
    }
    const response = await handler.fetch(new Request(`http://127.0.0.1:${port}/mcp`, { method: req.method, headers: req.headers, ...(body ? { body } : {}) }));
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) { console.error(e); if (!res.headersSent) res.writeHead(500); res.end(); }
});
http.listen(port, '127.0.0.1', () => console.error(`MCP em http://127.0.0.1:${port}/mcp`));
