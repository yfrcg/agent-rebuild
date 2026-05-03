import { ContainerCliRuntimeProvider } from "../runtime";

export class DockerSandboxProvider extends ContainerCliRuntimeProvider {
  readonly backend = "docker" as const;
  protected readonly command: string;

  constructor(command = "docker") {
    super();
    this.command = command;
  }
}

