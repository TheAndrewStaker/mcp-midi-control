// Minimal type declarations for the `midi` package (no @types/midi published).
declare module 'midi' {
  type MessageHandler = (deltaTime: number, message: number[]) => void;

  class Input {
    getPortCount(): number;
    getPortName(index: number): string;
    openPort(index: number): void;
    openVirtualPort(name: string): void;
    closePort(): void;
    isPortOpen(): boolean;
    on(event: 'message', handler: MessageHandler): this;
    ignoreTypes(sysex: boolean, timing: boolean, activeSensing: boolean): void;
  }

  class Output {
    getPortCount(): number;
    getPortName(index: number): string;
    openPort(index: number): void;
    openVirtualPort(name: string): void;
    closePort(): void;
    isPortOpen(): boolean;
    sendMessage(message: number[]): void;
  }

  const _default: { Input: typeof Input; Output: typeof Output };
  export default _default;
  export { Input, Output };
}
