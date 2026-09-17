import { createHash, randomUUID } from "node:crypto";

export const hashText = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export interface RequestProof {
  kind: "request";
  botId: string;
  subject: string;
  accountId: string;
  conversation: string;
  spaceName: string;
  senderId: string;
  requestId: string;
  interactionId: string;
  messageHash: string;
  expiresAt: number;
}
interface ReplyProof {
  kind: "reply";
  botId: string;
  conversation: string;
  subject: string;
  accountId: string;
  interactionId: string;
  requestId: string;
  text: string;
  expiresAt: number;
}
export const PROTECTED_REPLY = "[Protected Linear SH reply]";
export class Tickets {
  constructor(
    private encrypt: (value: string) => string,
    private decrypt: (value: string) => string,
    private now = Date.now,
  ) {}
  request(
    input: Omit<
      RequestProof,
      "kind" | "requestId" | "expiresAt" | "messageHash"
    >,
    message: string,
  ) {
    return this.encrypt(
      JSON.stringify({
        ...input,
        kind: "request",
        requestId: randomUUID(),
        messageHash: hashText(message),
        expiresAt: this.now() + 120000,
      }),
    );
  }
  private read(
    ticket: string,
    kind: string,
    allowExpired = false,
  ): RequestProof | ReplyProof {
    if (typeof ticket !== "string" || ticket.length > 150000)
      throw new Error("Invalid proof");
    const data = JSON.parse(this.decrypt(ticket));
    if (
      data.kind !== kind ||
      !Number.isFinite(data.expiresAt) ||
      (!allowExpired && data.expiresAt <= this.now())
    )
      throw new Error("Expired proof");
    return data;
  }
  resolve(
    ticket: string,
    botId: string,
    spaceName: string,
    senderId: string,
    message: string,
    allowExpired = false,
  ): RequestProof {
    const p = this.read(ticket, "request", allowExpired) as RequestProof;
    if (
      !p.interactionId ||
      p.botId !== botId ||
      p.spaceName !== spaceName ||
      p.senderId !== senderId ||
      p.messageHash !== hashText(message)
    )
      throw new Error("Proof binding mismatch");
    return p;
  }
  reply(request: RequestProof, text: string) {
    // Task text remains encrypted through back/pusher transport, including older fleet members.
    return this.encrypt(
      JSON.stringify({
        kind: "reply",
        botId: request.botId,
        conversation: request.conversation,
        subject: request.subject,
        accountId: request.accountId,
        interactionId: request.interactionId,
        requestId: request.requestId,
        text,
        expiresAt: this.now() + 30000,
      }),
    );
  }
  verifyReply(
    ticket: string,
    botId: string,
    conversation: string,
    text: string,
    interactionId: string,
  ) {
    const p = this.read(ticket, "reply") as ReplyProof;
    if (
      p.botId !== botId ||
      p.conversation !== conversation ||
      p.interactionId !== interactionId ||
      !interactionId ||
      text !== PROTECTED_REPLY ||
      typeof p.text !== "string"
    )
      throw new Error("Reply binding mismatch");
    return p;
  }
}
