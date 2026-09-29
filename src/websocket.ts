/**
 * WebSocket — envia eventos em tempo real para o app do ciclista.
 * Exige o JWT do login na URL de conexão.
 */

import { Server } from "http";
import { WebSocket, WebSocketServer } from "ws";
import { validarToken } from "./auth";
import { MensagemWS, TipoMensagemWS } from "./tipos";

const clientes = new Set<WebSocket>();
let aoConectar: ((ws: WebSocket) => void) | null = null;

export function inicializarWebSocket(
  httpServer: Server,
  opcoes: { aoConectar?: (enviar: (m: MensagemWS) => void) => void } = {}
): WebSocketServer {
  const wss = new WebSocketServer({
    server: httpServer,
    path: "/ws",
    // Só aceita a conexão se vier com um JWT válido: wss://.../ws?token=<jwt>
    verifyClient: (info, responder) => {
      const url = new URL(info.req.url ?? "/", "http://localhost");
      const token = url.searchParams.get("token");
      if (token && validarToken(token)) return responder(true);
      console.log("[WS] Conexão recusada: sem token válido");
      responder(false, 401, "Unauthorized");
    },
  });

  aoConectar = opcoes.aoConectar
    ? (ws) => opcoes.aoConectar!((m) => enviarPara(ws, m))
    : null;

  wss.on("connection", (ws) => {
    clientes.add(ws);
    console.log(`[WS] Cliente conectado (total: ${clientes.size})`);
    enviarPara(ws, { tipo: "BOAS_VINDAS", payload: { mensagem: "Conectado ao CyclistSafe" } });
    aoConectar?.(ws);

    ws.on("message", (dados) => {
      try {
        const msg = JSON.parse(dados.toString());
        if (msg?.tipo === "PING") enviarPara(ws, { tipo: "PONG", payload: {} });
      } catch {
        // ignora mensagens inválidas
      }
    });

    ws.on("close", () => {
      clientes.delete(ws);
      console.log(`[WS] Cliente desconectado (total: ${clientes.size})`);
    });

    ws.on("error", () => clientes.delete(ws));
  });

  console.log("[WS] WebSocket pronto em /ws");
  return wss;
}

function enviarPara(ws: WebSocket, msg: MensagemWS): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

export function transmitir(tipo: TipoMensagemWS, payload: unknown): void {
  const texto = JSON.stringify({ tipo, payload });
  for (const ws of clientes) {
    if (ws.readyState === WebSocket.OPEN) ws.send(texto);
  }
}

export function clientesConectados(): number {
  return clientes.size;
}
