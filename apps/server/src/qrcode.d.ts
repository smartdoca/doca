declare module "qrcode" {
  export interface QRCodeToStringOptions {
    readonly type?: "svg" | "utf8" | "terminal";
    readonly margin?: number;
    readonly width?: number;
    readonly errorCorrectionLevel?: "L" | "M" | "Q" | "H";
  }

  export function toString(
    value: string,
    options?: QRCodeToStringOptions,
  ): Promise<string>;
}
