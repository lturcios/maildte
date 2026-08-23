import { Attachment, AddressObject, ParsedMail, simpleParser } from 'mailparser';

export interface ParsedEmailMessage {
  messageId: string;
  subject: string;
  senderName: string;
  senderEmail: string;
  recipients: string[];
  receivedAt: Date;
  attachments: Attachment[];
}

function toAddressList(to: ParsedMail['to']): AddressObject['value'] {
  if (!to) return [];
  const objects = Array.isArray(to) ? to : [to];
  return objects.flatMap((o) => o.value);
}

/**
 * Parsea el mensaje crudo (msg.source de ImapFlow) con mailparser.
 * messageId y receivedAt tienen fallback: algunos emisores de DTE envían
 * mensajes sin header Message-ID o con Date ausente/inválido.
 */
export async function parseMessage(
  source: Buffer,
  uid: number,
  accountId: string,
): Promise<ParsedEmailMessage> {
  const parsed = await simpleParser(source);

  return {
    messageId: parsed.messageId ?? `synthetic-${accountId}-${uid}`,
    subject: parsed.subject ?? '',
    senderName: parsed.from?.value[0]?.name ?? '',
    senderEmail: (parsed.from?.value[0]?.address ?? '').toLowerCase(),
    recipients: toAddressList(parsed.to)
      .map((a) => a.address ?? '')
      .filter(Boolean),
    receivedAt: parsed.date ?? new Date(),
    attachments: parsed.attachments,
  };
}

/** Criterio OR (RF-03.2): extensión .json/.pdf O mimeType application/json|pdf. Basta uno. */
export function isTargetAttachment(attachment: Attachment): boolean {
  return (
    /\.(json|pdf)$/i.test(attachment.filename ?? '') ||
    ['application/json', 'application/pdf'].includes(attachment.contentType)
  );
}

export function classifyAttachment(attachment: Attachment): 'JSON' | 'PDF' {
  return /\.json$/i.test(attachment.filename ?? '') || attachment.contentType === 'application/json'
    ? 'JSON'
    : 'PDF';
}
