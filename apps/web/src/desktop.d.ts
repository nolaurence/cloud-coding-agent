export {};
declare global {
  interface Window {
    ccaDesktop?: {
      platform: string;
      browser: {
        attach(threadId: string, ticket: string, bounds: { x: number; y: number; width: number; height: number }): Promise<void>;
        updateBounds(threadId: string, bounds: { x: number; y: number; width: number; height: number }): void;
        setVisible(threadId: string, visible: boolean): void;
        detach(threadId: string): void;
      };
    };
  }
}
