import { queryMany, queryOne } from '../db/pool.js';
import { AppError } from '../lib/errors.js';

// The signed-in wallet's account: created by the first sign-in
// (private.resolve_or_create_base_account), read by the console.
export class AccountRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async getMe(appUserId) {
    const user = await queryOne(this.pool,
      `select u.id, u.status, u.created_at, p.display_name, p.avatar_url, p.locale, p.timezone
       from public.app_users u
       left join public.user_profiles p on p.app_user_id = u.id
       where u.id = $1`, [appUserId]);
    if (!user) throw new AppError('USER_NOT_FOUND', 'User not found', 404);
    const wallets = await queryMany(this.pool,
      `select id, chain_id, address, label, verified_at, created_at
       from public.user_wallets where app_user_id = $1 and status = 'active'
       order by created_at`, [appUserId]);
    return { ...user, wallets };
  }
}
