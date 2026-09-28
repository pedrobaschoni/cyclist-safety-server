/**
 * Envio de SMS pelo Twilio (API REST, sem biblioteca extra).
 *
 * Sem as variáveis TWILIO_* configuradas, o servidor funciona em
 * MODO SIMULADO: o SMS é apenas mostrado no log e registrado no banco
 * com status "SIMULADO". Útil para desenvolvimento e demonstrações.
 */

export type StatusEnvio = "ENVIADO" | "SIMULADO" | "FALHOU";

export interface ResultadoEnvio {
  status: StatusEnvio;
  erro?: string;
}

export function smsConfigurado(): boolean {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      process.env.TWILIO_FROM
  );
}

/**
 * Remove acentos: SMS com acentos (ã, ê, õ...) usa outra codificação
 * e cabe menos texto por mensagem, o que aumenta o custo.
 */
function semAcentos(texto: string): string {
  return texto.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

export async function enviarSms(para: string, texto: string): Promise<ResultadoEnvio> {
  const corpo = semAcentos(texto);

  if (!smsConfigurado()) {
    console.log(`[SMS SIMULADO] Para ${para}: ${corpo}`);
    return { status: "SIMULADO" };
  }

  const sid = process.env.TWILIO_ACCOUNT_SID as string;
  const token = process.env.TWILIO_AUTH_TOKEN as string;
  const de = process.env.TWILIO_FROM as string;

  try {
    const resposta = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ To: para, From: de, Body: corpo }).toString(),
      }
    );

    if (!resposta.ok) {
      const detalhe = (await resposta.text()).slice(0, 300);
      console.error(`[SMS] Falha para ${para}: ${resposta.status} ${detalhe}`);
      return { status: "FALHOU", erro: `HTTP ${resposta.status}: ${detalhe}` };
    }

    console.log(`[SMS] Enviado para ${para}`);
    return { status: "ENVIADO" };
  } catch (e) {
    const erro = e instanceof Error ? e.message : String(e);
    console.error(`[SMS] Erro de rede para ${para}: ${erro}`);
    return { status: "FALHOU", erro };
  }
}
