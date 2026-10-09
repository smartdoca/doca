// Built-in pages still use the host's dashboard and folder navigation chrome.
export function pluginRouteScope(routeId: string): string {
  switch (routeId) {
    case "doca.documents.route.home":
      return "documents";
    case "doca.documents.route.libraries":
      return "libraries";
    case "doca.files.route.files":
      return "files";
    case "doca.files.route.shared":
    case "doca.files.route.shared-join":
    case "doca.files.route.shared-folder":
      return "shared-files";
    default:
      return "plugin";
  }
}
