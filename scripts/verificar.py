#!/usr/bin/env python3
"""Sobe processos limpos, roda o validador original e verifica restart/integridade."""
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'validador'))
import validar as v


def wait_port(port):
    import socket
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(('127.0.0.1', port), timeout=.2):
                return
        except OSError:
            time.sleep(.1)
    raise RuntimeError(f'Porta {port} nao abriu')


def stop(process):
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()


def main():
    import socket
    for port in (7300, 7301):
        with socket.socket() as sock:
            if sock.connect_ex(('127.0.0.1', port)) == 0:
                raise RuntimeError(f'Pare o processo na porta {port} antes do teste')
    env = {**os.environ, 'REQUEST_STATE_SECRET': secrets.token_hex(32)}
    processes = []
    with open(ROOT / 'mcp.log', 'w') as mcp_log, open(ROOT / 'agente.log', 'w') as agent_log:
        def start_mcp():
            p = subprocess.Popen(['node', 'servidor-mcp/index.mjs'], cwd=ROOT, env=env, stderr=mcp_log)
            processes.append(p)
            wait_port(7301)
            return p
        try:
            mcp = start_mcp()
            agent = subprocess.Popen(['node', 'agente/index.mjs'], cwd=ROOT, env=env, stderr=agent_log)
            processes.append(agent)
            wait_port(7300)
            output = subprocess.run([sys.executable, 'validador/validar.py'], cwd=ROOT, capture_output=True, text=True)
            print(output.stdout, end='')
            (ROOT / 'validacao.log').write_text(output.stdout + output.stderr)
            if output.returncode:
                return output.returncode
            url = 'http://127.0.0.1:7301/mcp'
            stop(mcp)
            mcp = start_mcp()
            _, response = v.reservar(url, 'sala-garagem', v.h('14:00'), v.h('15:00'), 'Restart')
            result = response['result']
            key = next(iter(result['inputRequests']))
            state = result['requestState']
            stop(mcp)
            mcp = start_mcp()
            _, response = v.retomar(url, 'sala-garagem', v.h('14:00'), v.h('15:00'), key, {'action': 'accept', 'content': {'sala': 'sala-fusca'}}, state, 'Restart')
            assert response['result']['structuredContent']['sala'] == 'sala-fusca', response
            print('PASS extra: requestState valido apos restart do MCP')
            _, response = v.reservar(url, 'sala-fusca', v.h('16:00'), v.h('17:00'))
            result = response['result']
            key = next(iter(result['inputRequests']))
            _, response = v.retomar(url, 'sala-fusca', v.h('16:00'), v.h('17:00'), key, {'action': 'cancel'}, result['requestState'])
            assert response['result']['structuredContent']['reservado'] is False, response
            print('PASS extra: action cancel conclui sem reservar')
            body = {'jsonrpc': '2.0', 'id': 'header', 'method': 'tools/list', 'params': {'_meta': {'io.modelcontextprotocol/protocolVersion': v.PROTOCOLO, 'io.modelcontextprotocol/clientCapabilities': {}}}}
            status, response = v.post(url, body, {'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'MCP-Protocol-Version': v.PROTOCOLO, 'Mcp-Method': 'tools/call'})
            assert status == 400 and response['error']['code'] == -32020, response
            print('PASS extra: header divergente rejeitado com -32020')
            minted = subprocess.check_output(['node', '--input-type=module', '-e',
                "import {createRequestStateCodec} from '@modelcontextprotocol/server'; console.log(await createRequestStateCodec({key:Buffer.from(process.env.REQUEST_STATE_SECRET,'hex'),ttlSeconds:1,bind:()=> 'tools/call'}).mint({tool:'reservar_sala'}, {}))"], cwd=ROOT, env=env, text=True).strip()
            time.sleep(2)
            _, response = v.retomar(url, 'sala-garagem', v.h('14:00'), v.h('15:00'), key, {'action': 'decline'}, minted)
            assert response['error']['code'] == -32602, response
            print('PASS extra: requestState expirado rejeitado com -32602')

            return 0
        finally:
            for process in processes:
                if process.poll() is None:
                    stop(process)


if __name__ == '__main__':
    sys.exit(main())
