import { InvalidOperation } from "./errors.ts";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export type SendEmail = (message: EmailMessage) => Promise<void>;

export const sendOrganizationInvitation = async (
  sendEmail: SendEmail | undefined,
  platformUrl: string,
  { id, email, organizationName }: { id: string; email: string; organizationName: string },
) => {
  if (!sendEmail)
    throw new InvalidOperation({ code: "CONFLICT", message: "Invitation email is not configured" });
  await sendEmail({
    to: email,
    subject: `Invitation to ${organizationName}`,
    text: `You have been invited to ${organizationName} on Widefleet.\n\nAccept your invitation: ${platformUrl}/invitations/${id}\n\nThis invitation expires in 48 hours. If you were not expecting it, you can ignore this email.`,
  });
};
