# API Authentication Guide

## ⚠️ IMPORTANT: Always Use `authenticatedFetch` for API Calls

When making API calls to `/api/admin/*` or `/api/auth/*` endpoints from client-side code, **always use `authenticatedFetch`** instead of plain `fetch`.

### Why?

- In HTTP iframes (dev environment), cookies may not work reliably
- The token must be included in the URL for the middleware to authenticate requests
- `authenticatedFetch` automatically includes the token in both the URL and Authorization header

### ✅ Correct Usage

```typescript
import { authenticatedFetch } from '@/lib/client-auth';

// GET request
const response = await authenticatedFetch('/api/admin/users');

// GET with query params
const response = await authenticatedFetch(`/api/admin/users/${userId}`);

// POST request
const response = await authenticatedFetch('/api/admin/universes', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(data),
});

// PATCH request
const response = await authenticatedFetch(`/api/admin/universes/${id}`, {
  method: 'PATCH',
  headers: {
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(data),
});

// DELETE request
const response = await authenticatedFetch(`/api/admin/universes/${id}`, {
  method: 'DELETE',
});
```

### ❌ Wrong Usage (Will Cause 401 Errors)

```typescript
// DON'T DO THIS - cookies won't work in HTTP iframes
const response = await fetch('/api/admin/users', {
  credentials: 'include',
});

// DON'T DO THIS - token won't be in URL
const response = await fetch('/api/admin/users', {
  headers: {
    'Authorization': `Bearer ${token}`,
  },
});
```

### Dynamic Import Pattern

If you're in a client component and want to avoid bundling issues, use dynamic import:

```typescript
const { authenticatedFetch } = await import('@/lib/client-auth');
const response = await authenticatedFetch('/api/admin/users');
```

### What `authenticatedFetch` Does

1. Checks the current URL for `_token` or `_session` parameter
2. Falls back to `localStorage` if not in URL
3. Automatically appends the token to the request URL
4. Also includes it in the `Authorization` header as a fallback
5. Includes `credentials: 'include'` for cookie fallback

### Checklist for New API Calls

When adding a new API call:
- [ ] Use `authenticatedFetch` instead of `fetch`
- [ ] Remove `credentials: 'include'` (it's included automatically)
- [ ] Keep other headers (like `Content-Type`) as needed
- [ ] Test in an iframe to ensure it works

### Finding All API Calls

To find all API calls that might need updating:

```bash
# Find all fetch calls to /api/admin
grep -r "fetch.*['\`]/api/admin" app/admin

# Find all fetch calls to /api/auth
grep -r "fetch.*['\`]/api/auth" app/admin
```

