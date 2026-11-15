// Tạo / cập nhật tài khoản nhân viên cho một chi nhánh.
//
// Vì sao phải là Edge Function: tạo user và đổi mật khẩu bắt buộc dùng Admin API
// (service_role key). Key này KHÔNG được để trong web container — xem
// docs/06-production-go-live-checklist.md. Frontend gọi qua
// supabase.functions.invoke('manage-branch-user', ...) kèm access token của owner.
//
// Quyền: chỉ `owner` / `superadmin` của đúng tổ chức chứa chi nhánh đích.
// Hạn mức: chặn khi số user đang hoạt động của tổ chức vượt plan.max_users
// (docs/01 §11.3).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'

const supabaseUrl = Deno.env.get('SUPABASE_URL')
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
const internalEmailDomain = Deno.env.get('INTERNAL_EMAIL_DOMAIN') ?? 'pos.local'

if (!supabaseUrl || !serviceRoleKey || !anonKey) {
  throw new Error('Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY')
}

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false },
})

const MIN_PASSWORD_LENGTH = 10
const ASSIGNABLE_ROLES = new Set(['staff', 'manager', 'owner'])

type CreatePayload = {
  action: 'create'
  branch_id: number
  username: string
  password: string
  full_name?: string | null
  role?: string
  hourly_rate?: number
}

type UpdatePayload = {
  action: 'update'
  user_id: string
  branch_id?: number        // shop cần đổi vai trò (vai trò theo shop)
  password?: string
  full_name?: string | null
  role?: string
  hourly_rate?: number
  is_active?: boolean
}

type CreateStorePayload = {
  action: 'create_store'
  name: string
  address?: string | null
  phone?: string | null
  subscription_tier?: string
  subscription_expires_at?: string | null
  owner_username: string
  owner_password: string
  owner_full_name?: string | null
}

type UpdateStorePayload = {
  action: 'update_store'
  organization_id: number
  name?: string
  address?: string | null
  phone?: string | null
  subscription_tier?: string
  subscription_expires_at?: string | null
  is_active?: boolean
}

type DeleteStorePayload = {
  action: 'delete_store'
  organization_id: number
}

type Payload = CreatePayload | UpdatePayload | CreateStorePayload | UpdateStorePayload | DeleteStorePayload

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status })
}

function fail(detail: string, status = 400): Response {
  return json({ detail }, status)
}

type Actor = {
  id: string
  organization_id: number
  isSuperadmin: boolean
  isOrgOwner: boolean
  managerBranchIds: number[]
}

// Định danh người gọi từ access token, rồi đọc quyền thật trong DB.
// Không tin role trong JWT vì token có thể được cấp trước khi đổi quyền.
// Vai trò theo shop: owner toàn tổ chức (assignment branch_id null) quản lý mọi
// shop; manager của một shop chỉ tạo được tài khoản staff cho đúng shop đó.
async function resolveActor(request: Request): Promise<{ error: Response } | { actor: Actor }> {
  const authHeader = request.headers.get('Authorization') ?? ''
  const token = authHeader.replace(/^Bearer\s+/i, '')
  if (!token) return { error: fail('Thiếu access token.', 401) }

  const { data: userData, error: userError } = await admin.auth.getUser(token)
  if (userError || !userData?.user) return { error: fail('Phiên đăng nhập không hợp lệ.', 401) }

  const { data: profile, error: profileError } = await admin
    .from('profiles')
    .select('id, role, organization_id, branch_id, is_active')
    .eq('id', userData.user.id)
    .single()

  if (profileError || !profile) return { error: fail('Không tìm thấy hồ sơ người dùng.', 403) }
  if (!profile.is_active) return { error: fail('Tài khoản đã bị khóa.', 403) }

  const [{ data: platformAdmin }, { data: assignments, error: assignmentsError }] = await Promise.all([
    admin.from('platform_admins').select('user_id').eq('user_id', profile.id).maybeSingle(),
    admin.from('user_assignments').select('organization_id, branch_id, role').eq('user_id', profile.id),
  ])
  if (assignmentsError) return { error: fail('Không đọc được phân quyền.', 500) }

  const rows = (assignments ?? []) as { organization_id: number; branch_id: number | null; role: string }[]
  const actor: Actor = {
    id: profile.id,
    organization_id: profile.organization_id,
    isSuperadmin: !!platformAdmin,
    isOrgOwner: rows.some((a) =>
      a.branch_id === null && a.role === 'owner' && a.organization_id === profile.organization_id),
    managerBranchIds: rows
      .filter((a) => a.branch_id !== null && (a.role === 'manager' || a.role === 'owner'))
      .map((a) => a.branch_id as number),
  }

  if (!actor.isSuperadmin && !actor.isOrgOwner && actor.managerBranchIds.length === 0) {
    return { error: fail('Chỉ chủ cửa hàng hoặc quản lý shop mới được quản lý tài khoản nhân viên.', 403) }
  }

  return { actor }
}

function canManageOrg(actor: Actor, organizationId: number): boolean {
  return actor.isSuperadmin || (actor.isOrgOwner && actor.organization_id === organizationId)
}

// user_assignments dùng UNIQUE dạng index biểu thức
// (user_id, organization_id, coalesce(branch_id, -1)) nên PostgREST không upsert
// theo onConflict được — phải tự kiểm tra rồi insert/update.
// branchId = null → vai trò toàn tổ chức (owner).
async function assignBranchRole(
  userId: string,
  organizationId: number,
  branchId: number | null,
  role: string,
): Promise<string | null> {
  let query = admin
    .from('user_assignments')
    .select('id')
    .eq('user_id', userId)
    .eq('organization_id', organizationId)
  query = branchId === null ? query.is('branch_id', null) : query.eq('branch_id', branchId)
  const { data: existing, error: selectError } = await query.maybeSingle()

  if (selectError) return selectError.message

  if (existing) {
    const { error } = await admin
      .from('user_assignments')
      .update({ role })
      .eq('id', existing.id)
    return error?.message ?? null
  }

  const { error } = await admin
    .from('user_assignments')
    .insert({ user_id: userId, organization_id: organizationId, branch_id: branchId, role })
  return error?.message ?? null
}

async function assertUserQuota(organizationId: number): Promise<string | null> {
  const { data: org, error: orgError } = await admin
    .from('organizations')
    .select('id, plan_id, subscription_plans(max_users)')
    .eq('id', organizationId)
    .single()

  if (orgError || !org) return 'Không đọc được thông tin tổ chức.'

  const maxUsers = (org as { subscription_plans?: { max_users?: number } }).subscription_plans?.max_users
  if (!maxUsers) return null // gói không giới hạn

  const { count, error: countError } = await admin
    .from('profiles')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId)
    .eq('is_active', true)

  if (countError) return 'Không đếm được số tài khoản đang hoạt động.'
  if ((count ?? 0) >= maxUsers) {
    return `Gói dịch vụ chỉ cho phép ${maxUsers} tài khoản đang hoạt động. Hãy khóa bớt tài khoản cũ hoặc nâng gói.`
  }
  return null
}

async function requireSuperadmin(actor: Actor): Promise<Response | null> {
  return actor.isSuperadmin ? null : fail('Chỉ superadmin mới được quản lý cửa hàng.', 403)
}

async function findPlanId(tier: string): Promise<number | null> {
  const { data: exact } = await admin
    .from('subscription_plans')
    .select('id')
    .eq('name', tier)
    .eq('is_active', true)
    .maybeSingle()

  if (exact?.id) return exact.id

  const { data: fallback } = await admin
    .from('subscription_plans')
    .select('id')
    .eq('is_active', true)
    .order('id', { ascending: true })
    .limit(1)
    .maybeSingle()

  return fallback?.id ?? null
}

async function seedBranchDefaults(
  organizationId: number,
  branchId: number,
  tier: string,
  expiresAt: string,
): Promise<string | null> {
  const serviceCodes = ['pos_fb', 'inventory', 'cashbook', 'crm_loyalty']
  const { error: subscriptionsError } = await admin
    .from('subscriptions')
    .insert(serviceCodes.map((service_code) => ({
      organization_id: organizationId,
      branch_id: branchId,
      service_code,
      status: 'active',
      plan: tier,
      expires_at: expiresAt,
    })))
  if (subscriptionsError) return subscriptionsError.message

  const { data: area, error: areaError } = await admin
    .from('areas')
    .insert({ organization_id: organizationId, branch_id: branchId, name: 'Main Floor' })
    .select('id')
    .single()
  if (areaError || !area) return areaError?.message ?? 'Không tạo được khu vực mặc định.'

  const { error: tablesError } = await admin
    .from('tables')
    .insert(['Table 1', 'Table 2', 'Table 3', 'Takeaway'].map((name) => ({
      organization_id: organizationId,
      branch_id: branchId,
      area_id: area.id,
      name,
      is_active: true,
    })))
  if (tablesError) return tablesError.message

  const { error: categoriesError } = await admin
    .from('expense_categories')
    .insert([
      { code: 'ingredients', name: 'Nguyên vật liệu', sub_categories: ['Nhập hàng', 'Vận chuyển'] },
      { code: 'operations', name: 'Vận hành', sub_categories: ['Điện', 'Nước', 'Internet', 'Mặt bằng'] },
      { code: 'payroll', name: 'Lương nhân viên', sub_categories: ['Lương', 'Thưởng', 'Phụ cấp'] },
      { code: 'marketing', name: 'Marketing', sub_categories: ['Quảng cáo', 'Khuyến mãi'] },
      { code: 'others', name: 'Khác', sub_categories: ['Khác'] },
    ].map((category) => ({ organization_id: organizationId, branch_id: branchId, ...category })))
  // approval_rules: trigger branches_seed_approval_rules đã tạo ngưỡng mặc định
  // khi insert chi nhánh (insert lại ở đây sẽ trùng khóa (branch_id, action_type)).
  return categoriesError?.message ?? null
}

async function handleCreate(actor: Actor, payload: CreatePayload) {
  const username = (payload.username ?? '').trim().toLowerCase()
  const password = payload.password ?? ''
  const role = payload.role ?? 'staff'

  if (!username) return fail('Tên đăng nhập là bắt buộc.')
  if (!/^[a-z0-9._-]+$/.test(username)) {
    return fail('Tên đăng nhập chỉ gồm chữ thường, số và các ký tự . _ -')
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return fail(`Mật khẩu phải có ít nhất ${MIN_PASSWORD_LENGTH} ký tự.`)
  }
  if (!ASSIGNABLE_ROLES.has(role)) return fail('Vai trò không hợp lệ.')
  if (!payload.branch_id) return fail('Thiếu chi nhánh.')

  const { data: branch, error: branchError } = await admin
    .from('branches')
    .select('id, organization_id')
    .eq('id', payload.branch_id)
    .single()

  if (branchError || !branch) return fail('Chi nhánh không tồn tại.')
  if (!canManageOrg(actor, branch.organization_id)) {
    // Quản lý một shop: chỉ tạo staff cho đúng shop mình quản lý.
    if (!actor.managerBranchIds.includes(branch.id)) {
      return fail('Bạn không quản lý shop này.', 403)
    }
    if (role !== 'staff') {
      return fail('Quản lý shop chỉ được tạo tài khoản nhân viên (staff).', 403)
    }
  }

  const quotaError = await assertUserQuota(branch.organization_id)
  if (quotaError) return fail(quotaError, 409)

  const email = username.includes('@') ? username : `${username}@${internalEmailDomain}`

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    // Quyền chỉ đặt trong app_metadata (client không sửa được); trigger
    // app.handle_new_auth_user() bỏ qua mọi quyền nằm trong user_metadata.
    user_metadata: {
      username,
      full_name: payload.full_name ?? null,
    },
    app_metadata: {
      role,
      organization_id: branch.organization_id,
      branch_id: branch.id,
    },
  })

  if (createError || !created?.user) {
    return fail(createError?.message ?? 'Không tạo được tài khoản.', 400)
  }

  // Trigger app.handle_new_auth_user() đã tạo profile từ app_metadata; cập nhật
  // thêm các trường không nằm trong metadata và bảo đảm giá trị đúng.
  const { error: profileError } = await admin
    .from('profiles')
    .update({
      username,
      full_name: payload.full_name ?? null,
      role,
      hourly_rate: payload.hourly_rate ?? 20000,
      organization_id: branch.organization_id,
      branch_id: branch.id,
      is_active: true,
      updated_at: new Date().toISOString(),
    })
    .eq('id', created.user.id)

  if (profileError) {
    // Không để lại auth user mồ côi nếu profile hỏng.
    await admin.auth.admin.deleteUser(created.user.id)
    return fail(`Tạo hồ sơ thất bại: ${profileError.message}`, 400)
  }

  // Owner = toàn tổ chức (tự có quyền ở mọi shop); manager/staff = đúng shop này.
  const assignmentError = await assignBranchRole(
    created.user.id, branch.organization_id, role === 'owner' ? null : branch.id, role)

  if (assignmentError) {
    await admin.auth.admin.deleteUser(created.user.id)
    return fail(`Phân quyền chi nhánh thất bại: ${assignmentError}`, 400)
  }

  return json({ user_id: created.user.id, username, email, role })
}

async function handleUpdate(actor: Actor, payload: UpdatePayload) {
  if (!payload.user_id) return fail('Thiếu user_id.')

  const { data: target, error: targetError } = await admin
    .from('profiles')
    .select('id, role, organization_id, branch_id')
    .eq('id', payload.user_id)
    .single()

  if (targetError || !target) return fail('Tài khoản không tồn tại.', 404)
  // Đổi mật khẩu / vai trò / khóa: chỉ owner toàn tổ chức (hoặc superadmin).
  if (!canManageOrg(actor, target.organization_id)) {
    return fail('Chỉ chủ cửa hàng mới được sửa tài khoản nhân viên.', 403)
  }
  if (target.role === 'superadmin' && !actor.isSuperadmin) {
    return fail('Không được sửa tài khoản superadmin.', 403)
  }
  if (target.id === actor.id && payload.role !== undefined && payload.role !== 'owner') {
    return fail('Không tự hạ quyền của chính mình.', 400)
  }

  if (payload.password !== undefined && payload.password !== '') {
    if (payload.password.length < MIN_PASSWORD_LENGTH) {
      return fail(`Mật khẩu phải có ít nhất ${MIN_PASSWORD_LENGTH} ký tự.`)
    }
    const { error } = await admin.auth.admin.updateUserById(target.id, {
      password: payload.password,
    })
    if (error) return fail(`Đổi mật khẩu thất bại: ${error.message}`, 400)
  }

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (payload.full_name !== undefined) updates.full_name = payload.full_name
  if (payload.hourly_rate !== undefined) updates.hourly_rate = payload.hourly_rate
  if (payload.is_active !== undefined) updates.is_active = payload.is_active
  if (payload.role !== undefined) {
    if (!ASSIGNABLE_ROLES.has(payload.role)) return fail('Vai trò không hợp lệ.')
    updates.role = payload.role
  }

  const { error: updateError } = await admin
    .from('profiles')
    .update(updates)
    .eq('id', target.id)

  if (updateError) return fail(`Cập nhật hồ sơ thất bại: ${updateError.message}`, 400)

  // Vai trò theo shop: payload.branch_id chọn shop cần đổi (mặc định shop chính
  // của tài khoản). Owner luôn là vai trò toàn tổ chức.
  const roleBranchId = payload.branch_id ?? target.branch_id
  if (payload.branch_id !== undefined) {
    const { data: roleBranch } = await admin
      .from('branches').select('organization_id').eq('id', payload.branch_id).maybeSingle()
    if (!roleBranch || roleBranch.organization_id !== target.organization_id) {
      return fail('Shop không thuộc tổ chức của tài khoản này.', 400)
    }
  }
  if (payload.role !== undefined && (roleBranchId || payload.role === 'owner')) {
    const assignmentError = await assignBranchRole(
      target.id, target.organization_id, payload.role === 'owner' ? null : roleBranchId, payload.role)
    if (assignmentError) {
      return fail(`Cập nhật phân quyền chi nhánh thất bại: ${assignmentError}`, 400)
    }
  }

  return json({ user_id: target.id, updated: true })
}

async function handleCreateStore(actor: Actor, payload: CreateStorePayload) {
  const permissionError = await requireSuperadmin(actor)
  if (permissionError) return permissionError

  const name = (payload.name ?? '').trim()
  const username = (payload.owner_username ?? '').trim().toLowerCase()
  const password = payload.owner_password ?? ''
  const tier = (payload.subscription_tier ?? 'free').trim() || 'free'
  const expiresAt = payload.subscription_expires_at ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()

  if (!name) return fail('Tên cửa hàng là bắt buộc.')
  if (!username) return fail('Tên đăng nhập owner là bắt buộc.')
  if (!/^[a-z0-9._-]+$/.test(username)) {
    return fail('Tên đăng nhập owner chỉ gồm chữ thường, số và các ký tự . _ -')
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return fail(`Mật khẩu owner phải có ít nhất ${MIN_PASSWORD_LENGTH} ký tự.`)
  }

  const planId = await findPlanId(tier)
  const { data: organization, error: orgError } = await admin
    .from('organizations')
    .insert({ name, plan_id: planId, isolation_mode: 'shared', is_active: true })
    .select('id')
    .single()
  if (orgError || !organization) return fail(`Tạo tổ chức thất bại: ${orgError?.message ?? 'unknown error'}`, 400)

  const organizationId = organization.id as number
  let createdUserId: string | null = null

  const rollback = async () => {
    if (createdUserId) await admin.auth.admin.deleteUser(createdUserId)
    await admin.from('organizations').delete().eq('id', organizationId)
  }

  const { data: branch, error: branchError } = await admin
    .from('branches')
    .insert({
      organization_id: organizationId,
      name,
      address: payload.address ?? null,
      phone: payload.phone ?? null,
      is_active: true,
    })
    .select('id')
    .single()

  if (branchError || !branch) {
    await rollback()
    return fail(`Tạo chi nhánh thất bại: ${branchError?.message ?? 'unknown error'}`, 400)
  }

  const branchId = branch.id as number
  const defaultsError = await seedBranchDefaults(organizationId, branchId, tier, expiresAt)
  if (defaultsError) {
    await rollback()
    return fail(`Tạo dữ liệu mặc định thất bại: ${defaultsError}`, 400)
  }

  const email = username.includes('@') ? username : `${username}@${internalEmailDomain}`
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {
      username,
      full_name: payload.owner_full_name ?? null,
    },
    app_metadata: {
      role: 'owner',
      organization_id: organizationId,
      branch_id: branchId,
    },
  })

  if (createError || !created?.user) {
    await rollback()
    return fail(createError?.message ?? 'Không tạo được tài khoản owner.', 400)
  }
  createdUserId = created.user.id

  const { error: profileError } = await admin
    .from('profiles')
    .update({
      username,
      full_name: payload.owner_full_name ?? null,
      role: 'owner',
      hourly_rate: 0,
      organization_id: organizationId,
      branch_id: branchId,
      is_active: true,
      updated_at: new Date().toISOString(),
    })
    .eq('id', createdUserId)

  if (profileError) {
    await rollback()
    return fail(`Tạo hồ sơ owner thất bại: ${profileError.message}`, 400)
  }

  // Owner toàn tổ chức: tự có quyền ở mọi shop tạo sau này.
  const assignmentError = await assignBranchRole(createdUserId, organizationId, null, 'owner')
  if (assignmentError) {
    await rollback()
    return fail(`Phân quyền owner thất bại: ${assignmentError}`, 400)
  }

  return json({ organization_id: organizationId, branch_id: branchId, owner_user_id: createdUserId })
}

async function handleUpdateStore(actor: Actor, payload: UpdateStorePayload) {
  const permissionError = await requireSuperadmin(actor)
  if (permissionError) return permissionError
  if (!payload.organization_id) return fail('Thiếu organization_id.')
  if (payload.subscription_expires_at === null) {
    return fail('Hạn thuê bao là bắt buộc.')
  }

  const { data: branch } = await admin
    .from('branches')
    .select('id')
    .eq('organization_id', payload.organization_id)
    .order('id', { ascending: true })
    .limit(1)
    .maybeSingle()

  const tier = payload.subscription_tier?.trim()
  const orgUpdates: Record<string, unknown> = {}
  if (payload.name !== undefined) orgUpdates.name = payload.name
  if (payload.is_active !== undefined) orgUpdates.is_active = payload.is_active
  if (tier) orgUpdates.plan_id = await findPlanId(tier)

  if (Object.keys(orgUpdates).length > 0) {
    const { error } = await admin
      .from('organizations')
      .update(orgUpdates)
      .eq('id', payload.organization_id)
    if (error) return fail(`Cập nhật cửa hàng thất bại: ${error.message}`, 400)
  }

  if (branch?.id) {
    const branchUpdates: Record<string, unknown> = {}
    if (payload.name !== undefined) branchUpdates.name = payload.name
    if (payload.address !== undefined) branchUpdates.address = payload.address
    if (payload.phone !== undefined) branchUpdates.phone = payload.phone
    if (payload.is_active !== undefined) branchUpdates.is_active = payload.is_active

    if (Object.keys(branchUpdates).length > 0) {
      const { error } = await admin
        .from('branches')
        .update(branchUpdates)
        .eq('id', branch.id)
      if (error) return fail(`Cập nhật chi nhánh thất bại: ${error.message}`, 400)
    }

    const subscriptionUpdates: Record<string, unknown> = {}
    if (tier) subscriptionUpdates.plan = tier
    if (payload.subscription_expires_at !== undefined) subscriptionUpdates.expires_at = payload.subscription_expires_at
    if (payload.is_active !== undefined) subscriptionUpdates.status = payload.is_active ? 'active' : 'suspended'

    if (Object.keys(subscriptionUpdates).length > 0) {
      const { error } = await admin
        .from('subscriptions')
        .update(subscriptionUpdates)
        .eq('organization_id', payload.organization_id)
        .eq('branch_id', branch.id)
      if (error) return fail(`Cập nhật thuê bao thất bại: ${error.message}`, 400)
    }
  }

  return json({ organization_id: payload.organization_id, updated: true })
}

async function handleDeleteStore(actor: Actor, payload: DeleteStorePayload) {
  const permissionError = await requireSuperadmin(actor)
  if (permissionError) return permissionError
  if (!payload.organization_id) return fail('Thiếu organization_id.')
  if (payload.organization_id === actor.organization_id) {
    return fail('Không được xóa tổ chức đang chứa tài khoản superadmin hiện tại.', 403)
  }

  // Một transaction: tài khoản + cửa hàng + sổ cái cùng xóa hoặc cùng giữ nguyên.
  // (Trước đây xóa từng auth user trước, rồi DELETE organizations bị trigger sổ
  // cái chặn → cửa hàng mồ côi không còn tài khoản.)
  const { data, error } = await admin.rpc('purge_organization', {
    p_organization_id: payload.organization_id,
  })

  if (error) return fail(`Xóa cửa hàng thất bại: ${error.message}`, 400)
  return json(data)
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') {
    return fail('Method Not Allowed', 405)
  }

  const actorResult = await resolveActor(request)
  if ('error' in actorResult) return actorResult.error
  const actor = actorResult.actor

  let payload: Payload
  try {
    payload = await request.json()
  } catch {
    return fail('Body không phải JSON hợp lệ.')
  }

  switch (payload.action) {
    case 'create':
      return await handleCreate(actor, payload)
    case 'update':
      return await handleUpdate(actor, payload)
    case 'create_store':
      return await handleCreateStore(actor, payload)
    case 'update_store':
      return await handleUpdateStore(actor, payload)
    case 'delete_store':
      return await handleDeleteStore(actor, payload)
    default:
      return fail('action không hợp lệ.')
  }
})
