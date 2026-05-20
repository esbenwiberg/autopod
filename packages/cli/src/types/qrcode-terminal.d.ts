declare module 'qrcode-terminal' {
  interface GenerateOptions {
    small?: boolean;
  }
  export function generate(input: string, opts?: GenerateOptions): void;
  export function generate(input: string, opts: GenerateOptions, cb: (qr: string) => void): void;
  const _default: { generate: typeof generate };
  export default _default;
}
