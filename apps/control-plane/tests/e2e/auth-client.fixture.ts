import type { AuthClientExtension } from "../../src/lib/auth-client-extension.ts";

let challenge: HTMLInputElement | undefined;

// Keep a real mounted control across the email/code steps and require it for each send.
export const authClientExtension = {
  mountEmailCodeForm(container) {
    const input = document.createElement("input");
    input.id = `auth-challenge-${crypto.randomUUID()}`;
    input.type = "checkbox";
    const label = document.createElement("label");
    label.htmlFor = input.id;
    label.textContent = "Security check";
    container.append(input, label);
    challenge = input;

    return () => {
      input.remove();
      label.remove();

      if (challenge === input) challenge = undefined;
    };
  },
  plugins: [
    {
      id: "synthetic-auth-challenge",
      fetchPlugins: [
        {
          id: "synthetic-auth-challenge",
          name: "Synthetic security check",
          hooks: {
            onRequest: (context) => {
              if (
                new URL(context.url, window.location.origin).pathname !==
                "/api/auth/email-otp/send-verification-otp"
              )
                return context;

              if (!challenge?.checked)
                throw new Error("Complete the security check before requesting a code.");
              challenge.checked = false;

              return context;
            },
          },
        },
      ],
    },
  ],
} satisfies AuthClientExtension;
