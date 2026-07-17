export type User = {
  id: string;
  role: 'user' | 'admin';
};

export function requireAdmin(user: User | undefined): void {
  if (!user) {
    throw new Error('Authentication required');
  }
  if (user.role !== 'admin') {
    throw new Error('Admin role required');
  }
}
