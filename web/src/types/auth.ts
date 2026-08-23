/**
 * Tipos del dominio de autenticación, calcados del contrato real del backend
 * (ver src/auth/auth.controller.ts, src/auth/me.controller.ts y
 * prisma/schema.prisma en la raíz del repo).
 */

export type UserRole = 'SUPERADMIN' | 'ADMIN' | 'MIEMBRO';

export type TenantStatus = string;

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  maxAccounts: number;
  maxStorageBytes: number;
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  tenant: Tenant | null;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}
