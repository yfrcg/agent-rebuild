import { ContainerCliRuntimeProvider } from "../runtime";

export class PodmanSandboxProvider extends ContainerCliRuntimeProvider {
  readonly backend = "podman" as const;
  protected readonly command: string;

  constructor(command = "podman") {
    super();
    this.command = command;
  }
}

