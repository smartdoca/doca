import { defineService } from "./index.js";
import { FILES_SERVICE_ID, type FilesServiceV1 } from "@smartdoca/files-capability";
export * from "@smartdoca/files-capability";
export const filesServiceToken = defineService<FilesServiceV1>(FILES_SERVICE_ID);
