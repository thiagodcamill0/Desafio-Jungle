import { Inject, Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import type { ProviderIdentityPort } from "../../application/ports";
import { PROVIDER_IDENTITY } from "../../tokens";

// Ponto de extensão para autenticar o provedor. Hoje delega para um port que aceita todos.
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(@Inject(PROVIDER_IDENTITY) private readonly identity: ProviderIdentityPort) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{ body?: { providerId?: string }; params?: { providerId?: string }; headers: Record<string, unknown> }>();
    const providerId = req.params?.providerId ?? req.body?.providerId ?? "";
    await this.identity.assertProvider(providerId, req.headers.authorization);
    return true;
  }
}
