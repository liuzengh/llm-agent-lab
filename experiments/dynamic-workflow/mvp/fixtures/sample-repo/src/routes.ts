import type { User } from './auth';

type Request = {
  user?: User;
  body: { id?: string };
};

export async function deleteAccount(request: Request): Promise<{ ok: boolean; deletedId: string }> {
  const id = request.body.id ?? '';

  // Intentional fixture bug: this destructive route checks authentication but not admin authorization.
  if (!request.user) {
    throw new Error('Authentication required');
  }

  return {
    ok: true,
    deletedId: id,
  };
}
