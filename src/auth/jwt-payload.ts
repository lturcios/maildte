import { Role } from '@prisma/client';

export interface AccessTokenPayload {
  sub: string; // user id
  tenantId: string | null; // null solo para SUPERADMIN
  role: Role;
}

export interface RefreshTokenPayload {
  sub: string;
  jti: string;
}
