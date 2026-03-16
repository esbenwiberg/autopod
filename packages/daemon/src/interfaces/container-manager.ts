export interface ContainerSpawnConfig {
  image: string;
  sessionId: string;
  env: Record<string, string>;
  ports?: { container: number; host: number }[];
  volumes?: { host: string; container: string }[];
}

export interface ContainerManager {
  spawn(config: ContainerSpawnConfig): Promise<string>; // returns containerId
  kill(containerId: string): Promise<void>;
  writeFile(containerId: string, path: string, content: string): Promise<void>;
  getStatus(containerId: string): Promise<'running' | 'stopped' | 'unknown'>;
}
