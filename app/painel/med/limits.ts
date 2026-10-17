// Compartilhado entre o formulário (navegador) e a ação. O corpo da Server Action vai até 4 MB
// (experimental.serverActions.bodySizeLimit no next.config.ts); 64 KB ficam de folga para o texto e o multipart.
export const MED_UPLOAD_MAX_BYTES = 4 * 1024 * 1024 - 64 * 1024;
export const MED_UPLOAD_ERROR = "Anexos: até 5 arquivos e 4 MB somados. Reduza ou comprima os arquivos.";

export const attachmentsTooBig = (sizes: number[]) => sizes.reduce((n, s) => n + s, 0) > MED_UPLOAD_MAX_BYTES;
