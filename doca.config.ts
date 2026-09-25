import { defineDocaConfig, plugin } from "@doca/plugin-sdk";

export default defineDocaConfig({
  plugins: [
    plugin("@doca/plugin-files"),
    plugin("@doca/plugin-documents"),
    plugin("@doca/plugin-mail"),
  ],
});
