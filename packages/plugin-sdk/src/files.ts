import { defineService } from "./index.js";
import { FILES_SERVICE_ID, type FilesServiceV1 } from "@doca/files-capability";
export * from "@doca/files-capability";
export const filesServiceToken = defineService<FilesServiceV1>(FILES_SERVICE_ID);
