/**
 * Envio de SMS.
 *
 * Provedores (o primeiro que estiver configurado é usado):
 *  1. textbee  – usa um celular Android com chip como "gateway" de SMS.
 *                Variáveis: TEXTBEE_API_KEY (obrigatória) e
 *                TEXTBEE_DEVICE_ID (opcional; sem ela usa o celular padrão).
 *  2. Twilio   – TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN e TWILIO_FROM.
 *
 * Sem nenhuma dessas variáveis, o servidor funciona em MODO SIMULADO:
 * o SMS só aparece no log e é registrado no banco com status "SIMULADO".
 */

export type StatusEnvio = "ENVIADO" | "SIMULADO" | "FALHOU";
export type ProvedorSms = "textbee" | "twilio" | "simulado";

export interface ResultadoEnvio {
  status: StatusEnvio;
  erro?: string;
}

export function provedorSms(): ProvedorSms {
  if (process.env.TEXTBEE_API_KEY) return "textbee";
  if (
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_FROM
  ) {
    return "twilio";
  }
  return "simulado";
}

export function smsConfigurado(): boolean {
  return provedorSms() !== "simulado";
}

/**
 * Remove acentos: SMS com acentos (ã, ê, õ...) usa outra codificação,
 * cabe menos texto por mensagem e a operadora divide em mais partes.
 */
function semAcentos(texto: string): string {
  return texto.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** Transforma uma resposta de erro da API em um texto curto para o log/banco. */
async function erroHttp(resposta: Response): Promise<string> {
  const detalhe = (await resposta.text()).slice(0, 300);
  return `HTTP ${resposta.status}: ${detalhe}`;
}

// ── textbee ─────────────────────────────────────────────────────────────

async function enviarTextbee(para: string, corpo: string): Promise<ResultadoEnvio> {
  const chave = process.env.TEXTBEE_API_KEY as string;
  const dispositivo = process.env.TEXTBEE_DEVICE_ID;

  const dados: Record<string, unknown> = { recipients: [para], message: corpo };
  if (dispositivo) dados.deviceId = dispositivo;

  const resposta = await fetch("https://api.textbee.dev/api/v1/gateway/send-sms", {
    method: "POST",
    headers: { "x-api-key": chave, "Content-Type": "application/json" },
    body: JSON.stringify(dados),
    signal: AbortSignal.timeout(15_000),
  });

  if (!resposta.ok) {
    let erro = await erroHttp(resposta);
    if (resposta.status === 429) erro = "Limite do plano grátis do textbee atingido. " + erro;
    if (resposta.status === 401 || resposta.status === 403) erro = "Chave TEXTBEE_API_KEY inválida. " + erro;
    return { status: "FALHOU", erro };
  }
  // 200 = o textbee aceitou e repassou ao celular; não garante que já chegou.
  return { status: "ENVIADO" };
}

// ── Twilio ──────────────────────────────────────────────────────────────

async function enviarTwilio(para: string, corpo: string): Promise<ResultadoEnvio> {
  const sid = process.env.TWILIO_ACCOUNT_SID as string;
  const token = process.env.TWILIO_AUTH_TOKEN as string;
  const de = process.env.TWILIO_FROM as string;

  const resposta = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: para, From: de, Body: corpo }).toString(),
      signal: AbortSignal.timeout(15_000),
    }
  );

  if (!resposta.ok) return { status: "FALHOU", erro: await erroHttp(resposta) };
  return { status: "ENVIADO" };
}

// ── Função usada pelo resto do servidor ─────────────────────────────────

export async function enviarSms(para: string, texto: string): Promise<ResultadoEnvio> {
  const corpo = semAcentos(texto);
  const provedor = provedorSms();

  if (provedor === "simulado") {
    console.log(`[SMS SIMULADO] Para ${para}: ${corpo}`);
    return { status: "SIMULADO" };
  }

  try {
    const r = provedor === "textbee"
      ? await enviarTextbee(para, corpo)
      : await enviarTwilio(para, corpo);

    if (r.status === "ENVIADO") console.log(`[SMS] Enviado para ${para} via ${provedor}`);
    else console.error(`[SMS] Falha para ${para} via ${provedor}: ${r.erro}`);
    return r;
  } catch (e) {
    const erro = e instanceof Error ? e.message : String(e);
    console.error(`[SMS] Erro de rede para ${para} via ${provedor}: ${erro}`);
    return { status: "FALHOU", erro };
  }
}
