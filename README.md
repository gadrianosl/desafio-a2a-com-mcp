# A Ponte: MCP por dentro, A2A por fora

Agente determinístico de reserva de salas da Hill Valley Tech, com dois processos Node.js 20+, SDK oficial MCP **2.3.1**, revisão **2026-07-28**, e A2A **1.0** JSON-RPC. Sem LLM, banco ou sessão de protocolo.

## Como rodar

Requisitos: Node.js 20 ou superior, npm e Python 3.10 ou superior. Em um clone limpo:

```sh
git clone https://github.com/gadrianosl/desafio-a2a-com-mcp.git
cd desafio-a2a-com-mcp
npm ci
```

No primeiro terminal, gere uma chave aleatória e suba o MCP. Guarde a variável no terminal: ao reiniciar o servidor, use a mesma chave para conseguir retomar estados emitidos anteriormente. Gere uma chave nova somente para iniciar outro ambiente.

```sh
export REQUEST_STATE_SECRET="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
npm run start:mcp
```

No segundo terminal, dentro da mesma pasta:

```sh
npm run start:agente
```

No terceiro terminal:

```sh
curl http://localhost:7300/.well-known/agent-card.json
python3 validador/validar.py --agente http://localhost:7300 --mcp http://localhost:7301
```

O validador cria reservas. Antes de rodá-lo novamente, encerre ambos os processos com Ctrl+C e suba-os de novo. As reservas iniciais serão recarregadas dos JSON originais.

Também é possível executar todo o teste com processos temporários gerenciados pelo script, com as portas 7300 e 7301 livres:

```sh
python3 scripts/verificar.py
```

Esse script gera uma chave temporária sem publicá-la, inicia os dois processos, executa o validador original e testa restart, cancelamento, divergência de headers e expiração. Encerra os processos ao terminar. Produz `mcp.log`, `agente.log` e `validacao.log`, ignorados pelo Git. O stderr do MCP registra método, id e traceparent; compare o trace-id impresso pelo validador e os ids distintos das chamadas inicial e de continuação.

Configurações opcionais: `MCP_PORT` (7301), `AGENT_PORT` (7300), `MCP_URL` (`http://127.0.0.1:7301/mcp`) e `AGENT_URL` (URL pública anunciada no card, por padrão `http://127.0.0.1:7300`). Se mudar a porta do MCP, ajuste também `MCP_URL` no agente. Os processos escutam em loopback.

## Onde a ponte acontece

Em [`agente/index.mjs`](agente/index.mjs), `applyResult()` recebe o `input_required`, guarda o estado opaco e a chave da elicitation no mapa privado `bridges`, associado ao id da Task, e chama `alternatives()` para produzir `TASK_STATE_INPUT_REQUIRED`. Em `send()`, uma continuação com `taskId` consulta essa ponte e emite outro `client.request()` com os argumentos originais, a mesma chave em `inputResponses` e o `requestState` intacto. O SDK atribui um id JSON-RPC novo. O agente usa somente o schema público da pergunta para validar a escolha; nunca decodifica o estado. Recusa vira `decline`; resultado sem reserva vira `TASK_STATE_CANCELED`. O objeto Task público é separado do estado privado, evitando vazamento em mensagens, histórico e artifacts.

## Decisões técnicas

- **MCP oficial:** `McpServer`, `createMcpHandler` e Streamable HTTP em `/mcp`. A entrada HTTP exige os dois campos de `_meta` em cada request, inclusive antes de classificar a revisão. O SDK verifica os headers espelhados, a capability necessária, os schemas e o ciclo MRTR. Tools e resource são registrados no SDK; regras de sala estão apenas em `servidor-mcp/index.mjs`.
- **Estado protegido:** `createRequestStateCodec()` do SDK usa HMAC-SHA256 e expiração de **600 segundos**. A chave vem exclusivamente de `REQUEST_STATE_SECRET`, em hexadecimal, com pelo menos 32 bytes gerados aleatoriamente. O codec também vincula o estado ao método. O payload selado inclui a tool, o pedido original, as alternativas e a chave da pergunta. No retry o SDK verifica integridade e validade antes do handler; a reserva usa os valores selados, preservando-os contra alteração dos argumentos. Nenhum estado de pausa fica no MCP. Reiniciar o MCP mantendo a chave permite retomar o pedido.
- **Dados:** salas e política são lidas dos arquivos originais. As reservas ficam em memória no processo MCP. Horários são comparados como instantes e a janela é conferida em UTC-03:00. Intervalos adjacentes não conflitam. Alternativas são filtradas e ordenadas exclusivamente pelo servidor.
- **Host MCP:** um cliente oficial vivo, com negociação fixada na revisão exigida e `autoFulfill: false`. O agente chama `tools/list` antes da reserva, seleciona a tool anunciada, lê `politica://uso` e extrai a versão para o artifact. Os schemas de domínio não são duplicados no agente. Cada request carrega metadados de protocolo e capability form; o transporte oficial produz os headers espelhados. O traceparent recebido acompanha a descoberta inicial e as operações da Task, inclusive sua continuação.
- **Tasks:** os mapas `tasks` e `bridges` ficam na memória do agente. Tasks têm identidade, contexto, histórico e artifacts; passam por SUBMITTED e WORKING e ficam consultáveis durante chamadas HTTP ao MCP. Estados terminais não aceitam continuação. Reiniciar o agente perde suas Tasks, conforme o escopo permitido. Reiniciar o MCP preserva a validade do estado selado enquanto a chave e o prazo forem mantidos.
- **A2A:** binding JSON-RPC 2.0 implementado diretamente sobre HTTP, com `SendMessage`, `GetTask` e Agent Card v1.0. O enunciado exige SDK oficial para MCP; não exige SDK A2A. Pedidos seguem o formato fixo, incluindo nomes de responsável com espaços. Reservas no passado são aceitas.

### Limitação observada no SDK e caminho oficial usado

Em `@modelcontextprotocol/client@2.3.1`, `dist/index.mjs`, `Client.callTool()` executa a validação do outputSchema depois de receber o resultado, sem distinguir `input_required`. O trecho relevante é:

```js
if (result.structuredContent === void 0 && !result.isError)
  throw new ProtocolError(ProtocolErrorCode.InvalidRequest,
    `Tool ${params.name} has an output schema but did not return structured content`);
```

Isso rejeita uma pausa válida, que não possui structuredContent. A função `callTool()` local do agente usa o caminho oficial `client.request({ method: 'tools/call', params }, { allowInputRequired: true })`. Esse método mantém transporte, schemas de wire, ids, metadados e headers do SDK e entrega a pausa para a ponte. Nenhum código de protocolo MCP foi reimplementado para contornar a limitação. O outputSchema continua anunciado pelo servidor, e o próprio servidor valida os resultados completos. O validador verifica os resultados e a ponte de ponta a ponta.

## Saída do validador

Última execução com os dois processos recém-iniciados, sem alterações em `dados/`, `exemplos/` ou `validador/`:

```text
trace-id desta execucao: 2f1ffa66e33d219996c609dd8ae0f77a
procure esse valor no stderr do servidor MCP para conferir a propagacao do traceparent.

PASS 01 tools/list traz as tres tools
PASS 02 toda tool tem inputSchema de objeto
PASS 03 listar_salas devolve structuredContent e o mesmo JSON em texto
PASS 04 _meta sem protocolVersion devolve -32602 e HTTP 400
PASS 05 _meta sem clientCapabilities devolve -32602 e HTTP 400
PASS 06 tool inexistente e recusada, por -32602 ou por isError
PASS 07 resources/read de politica://uso devolve a politica
PASS 08 resources/read de URI inexistente devolve -32602
PASS 09 sala inexistente devolve isError com a mensagem exata
PASS 10 fora da janela devolve isError com a mensagem exata
PASS 11 duracao acima de 2h devolve isError com a mensagem exata
PASS 12 intervalo invertido devolve isError com a mensagem exata
PASS 13 conflito devolve input_required com inputRequests e requestState
PASS 14 a elicitation e form mode e oferece as alternativas na ordem certa
PASS 15 conflito sem a capability elicitation devolve -32021 e HTTP 400
PASS 16 retry com inputResponses e requestState conclui a reserva
PASS 17 requestState adulterado e rejeitado com -32602
PASS 18 argumentos adulterados no retry nao tomam efeito
PASS 19 recusa conclui sem reservar e sem isError
PASS 20 conflito sem alternativa possivel devolve isError com a mensagem exata

PASS 21 agent card responde 200 no well-known com JSON
PASS 22 o card declara a interface JSON-RPC com url e versao 1.0
PASS 23 o card declara a skill reservar-sala
PASS 24 SendMessage com sala livre conclui a Task
PASS 25 o artifact chama reserva e traz a versao da politica
PASS 26 GetTask devolve id, contextId e estado corrente
PASS 27 SendMessage com sala ocupada pausa a Task
PASS 28 a Task pausada lista as alternativas na ordem certa
PASS 29 escolha fora do enum mantem a Task pausada
PASS 30 a continuacao conclui a Task na sala escolhida
PASS 31 SendMessage em Task terminal e recusado
PASS 32 a recusa termina a Task em CANCELED
PASS 33 duas Tasks pausadas ao mesmo tempo concluem cada uma com a sua reserva
PASS 34 nenhuma resposta A2A carrega o requestState
PASS 35 sala inexistente termina a Task em FAILED com a mensagem da tool
PASS 36 o agente e deterministico: o mesmo pedido produz a mesma pausa

resumo: 36 passaram, 0 falharam, de 36 verificacoes
```
