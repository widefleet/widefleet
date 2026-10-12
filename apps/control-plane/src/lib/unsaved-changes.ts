import { beforeNavigate } from "$app/navigation";

export const warnBeforeLeaving = (hasChanges: () => boolean) => {
  beforeNavigate(({ cancel, from, to, type, willUnload }) => {
    if (!hasChanges()) return;

    // Reloading or closing the document requires the browser's native dialog.
    if (type === "leave") {
      cancel();

      return;
    }

    // Query and fragment changes keep the current editor mounted.
    if (!willUnload && from?.url.pathname === to?.url.pathname) return;

    if (!window.confirm("Discard your unsaved changes and leave this page?")) cancel();
  });
};
