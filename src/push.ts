/**
 * Notificações push para o app do ciclista (Firebase Cloud Messaging).
 *
 * Chegam mesmo com o app fechado ou minimizado: quem entrega é o próprio
 * Android (Google Play Services), não o app.
 *
 * Sem a variável FIREBASE_SERVICE_ACCOUNT o push fica desativado e o
 * restante do sistema continua funcionando normalmente.
 */

import { App, cert, initializeApp } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import { listarTokensPush, removerTokensPush } from "./db";

/** Mesmo canal criado pelo app (NotificationService._canalAlerta). */
const CANAL_ANDROID = "cyclistsafe_alerta_queda";

let appFirebase: App | null = null;
let tentouIniciar = false;

function iniciarFirebase(): App | null {
  if (tentouIniciar) return appFirebase;
  tentouIniciar = true;

  const texto = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!texto) {
    console.log("[Push] FIREBASE_SERVICE_ACCOUNT não configurada — push desativado");
    return null;
  }
  try {
    const conta = JSON.parse(texto);
    // Alguns painéis salvam as quebras de linha da chave como "\n" literal
    if (typeof conta.private_key === "string") {
      conta.private_key = conta.private_key.replace(/\\n/g, "\n");
    }
    appFirebase = initializeApp({ credential: cert(conta) }, "cyclistsafe");
    console.log(`[Push] Firebase ativo (projeto ${conta.project_id})`);
  } catch (e) {
    console.error(
      "[Push] FIREBASE_SERVICE_ACCOUNT inválida — cole o conteúdo INTEIRO do .json:",
      e instanceof Error ? e.message : e
    );
    appFirebase = null;
  }
  return appFirebase;
}

export function pushConfigurado(): boolean {
  return iniciarFirebase() !== null;
}

/**
 * Envia uma notificação para todos os celulares registrados.
 * `dados` chega ao app quando o usuário toca na notificação.
 */
export async function enviarPush(
  titulo: string,
  corpo: string,
  dados: Record<string, string>
): Promise<void> {
  const app = iniciarFirebase();
  if (!app) return;

  const tokens = await listarTokensPush();
  if (tokens.length === 0) {
    console.log("[Push] Nenhum celular registrado");
    return;
  }

  try {
    const resposta = await getMessaging(app).sendEachForMulticast({
      tokens,
      notification: { title: titulo, body: corpo },
      data: dados,
      android: {
        priority: "high", // entrega imediata, mesmo com o celular em repouso
        ttl: 10 * 60 * 1000,
        notification: {
          channelId: CANAL_ANDROID,
          priority: "max",
          sound: "default",
          defaultVibrateTimings: true,
          visibility: "public",
          tag: dados.quedaId, // a notificação nova substitui a anterior da mesma queda
        },
      },
    });

    // Remove celulares que desinstalaram o app ou trocaram de token
    const invalidos: string[] = [];
    resposta.responses.forEach((r, i) => {
      const codigo = r.error?.code ?? "";
      if (
        codigo === "messaging/registration-token-not-registered" ||
        codigo === "messaging/invalid-registration-token" ||
        codigo === "messaging/invalid-argument"
      ) {
        invalidos.push(tokens[i]);
      } else if (r.error) {
        console.error(`[Push] Falha: ${codigo} ${r.error.message}`);
      }
    });
    if (invalidos.length > 0) await removerTokensPush(invalidos);

    console.log(
      `[Push] "${titulo}" → ${resposta.successCount} entregue(s), ${resposta.failureCount} falha(s)`
    );
  } catch (e) {
    console.error("[Push] Erro ao enviar:", e instanceof Error ? e.message : e);
  }
}
