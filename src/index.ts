/**
 * Servidor intermediário — CyclistSafe 2.0
 * TypeScript + Express + WebSocket + PostgreSQL (Neon)
 *
 * TCC — IFSP Campus Presidente Epitácio
 */

import { createServer } from "http";
import { retomarAlertasPendentes } from "./alertas";
import { criarApp, ultimosStatusDispositivos } from "./app";
import { iniciarBanco } from "./db";
import { pushConfigurado } from "./push";
import { smsConfigurado } from "./sms";
import { inicializarWebSocket } from "./websocket";

const PORT = Number(process.env.PORT ?? 3000);

async function iniciar(): Promise<void> {
  await iniciarBanco();

  const app = criarApp();
  const httpServer = createServer(app);

  inicializarWebSocket(httpServer, {
    // Quem acabou de conectar já recebe o último status do ESP32
    aoConectar: (enviar) => {
      for (const s of ultimosStatusDispositivos()) enviar({ tipo: "STATUS", payload: s });
    },
  });

  await retomarAlertasPendentes();

  httpServer.listen(PORT, () => {
    console.log("╔════════════════════════════════════════════╗");
    console.log("║  CyclistSafe — servidor intermediário 2.2  ║");
    console.log("║  IFSP Campus Presidente Epitácio           ║");
    console.log("╚════════════════════════════════════════════╝");
    console.log(`Porta: ${PORT}`);
    console.log(`SMS: ${smsConfigurado() ? "Twilio (envio real)" : "SIMULADO (só aparece no log)"}`);
    console.log(`Push: ${pushConfigurado() ? "Firebase ativo" : "desativado (sem FIREBASE_SERVICE_ACCOUNT)"}`);
  });
}

iniciar().catch((e) => {
  console.error("Falha ao iniciar o servidor:", e);
  process.exit(1);
});
