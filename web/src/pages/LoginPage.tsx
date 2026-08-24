import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';

import { apiGet, apiPost, ApiError } from '@/lib/api-client';
import { useAuthStore } from '@/stores/auth-store';
import type { AuthTokens, AuthUser } from '@/types/auth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface AuthTokensResponse {
  data: AuthTokens;
}

interface AuthUserResponse {
  data: AuthUser;
}

export function LoginPage() {
  const navigate = useNavigate();
  const setTokens = useAuthStore((state) => state.setTokens);
  const setUser = useAuthStore((state) => state.setUser);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);

    try {
      const loginResponse = await apiPost<AuthTokensResponse>(
        '/auth/login',
        { email, password },
        true,
      );
      setTokens(loginResponse.data);

      const meResponse = await apiGet<AuthUserResponse>('/me');
      setUser(meResponse.data);

      // TenantRoute redirige a /organizaciones si el rol es SUPERADMIN.
      navigate('/', { replace: true });
    } catch (error) {
      if (error instanceof ApiError) {
        toast.error(error.message);
      } else {
        toast.error('No se pudo iniciar sesión. Intentá de nuevo.');
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-svh items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm border-border">
        <CardHeader className="space-y-1">
          <CardTitle className="font-display text-2xl">MailDTE Collector</CardTitle>
          <CardDescription>Panel de administración — iniciá sesión para continuar</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
            <div className="flex flex-col gap-2">
              <Label htmlFor="email">Correo electrónico</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="password">Contraseña</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
            <Button type="submit" className="mt-2" disabled={isSubmitting}>
              {isSubmitting ? 'Ingresando…' : 'Ingresar'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
