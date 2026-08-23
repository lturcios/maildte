export interface FakeMsg {
  uid: number;
  source: Buffer;
}

/** Mock de ImapFlow: fetch como generador sync (for-await funciona igual sobre iterables sync). */
export function imapFlowMock(messages: FakeMsg[], uidValidity: bigint = 100n, uidNext = 1) {
  return {
    connect: jest.fn().mockResolvedValue(undefined),
    logout: jest.fn().mockResolvedValue(undefined),
    close: jest.fn(),
    mailboxOpen: jest.fn().mockResolvedValue({ uidValidity, uidNext }),
    search: jest.fn().mockResolvedValue([]),
    fetch: jest.fn(function* () {
      yield* messages;
    }),
  };
}

export interface FakeAttachment {
  filename: string;
  contentType: string;
  body: string;
}

export interface FakeRawEmailOptions {
  messageId?: string;
  from: string;
  to?: string;
  subject?: string;
  date: string;
  attachments?: FakeAttachment[];
}

/** Construye un mensaje MIME multipart/mixed real (boundary fijo) para que mailparser lo parsee sin mocks. */
export function fakeRawEmail(opts: FakeRawEmailOptions): Buffer {
  const boundary = '----=_MailDTE_Boundary_Fixed';
  const lines: string[] = [];

  lines.push(`From: ${opts.from}`);
  lines.push(`To: ${opts.to ?? 'destino@ltsoft.us'}`);
  lines.push(`Subject: ${opts.subject ?? 'Asunto de prueba'}`);
  lines.push(`Date: ${opts.date}`);
  if (opts.messageId) {
    lines.push(`Message-ID: <${opts.messageId}>`);
  }
  lines.push('MIME-Version: 1.0');
  lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  lines.push('');
  lines.push(`--${boundary}`);
  lines.push('Content-Type: text/plain; charset=utf-8');
  lines.push('');
  lines.push('Cuerpo del correo de prueba.');

  for (const att of opts.attachments ?? []) {
    lines.push(`--${boundary}`);
    lines.push(`Content-Type: ${att.contentType}; name="${att.filename}"`);
    lines.push('Content-Transfer-Encoding: base64');
    lines.push(`Content-Disposition: attachment; filename="${att.filename}"`);
    lines.push('');
    lines.push(Buffer.from(att.body, 'utf8').toString('base64'));
  }

  lines.push(`--${boundary}--`);
  lines.push('');

  return Buffer.from(lines.join('\r\n'), 'utf8');
}
