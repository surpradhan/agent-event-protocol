# Security Policy

## Reporting a Vulnerability

**Please do not open public issues for security vulnerabilities.** Instead, please report them responsibly to:

📧 **Email:** [TODO: security@example.com]

Include:
- Description of the vulnerability
- Affected versions
- Steps to reproduce (if possible)
- Potential impact
- Suggested fix (if you have one)

We will acknowledge receipt within 48 hours and provide an initial assessment within 7 days.

---

## Security Guarantees

AEP provides the following security properties:

### ✅ Authentication
- **API Key Authentication** — All requests require Bearer token in `Authorization` header
- **Key Management** — Keys tied to `tenant_id` via SHA-256 hashing
- **Key Revocation** — Revoked keys are immediately rejected

### ✅ Authorization
- **Tenant Isolation** — Requests scoped to authenticated `tenant_id`
- **Cross-Tenant Rejection** — Access to other tenants' data returns 403
- **Per-Endpoint Scopes** — Different endpoints enforce `read` vs `write` permissions

### ✅ Data Integrity
- **HMAC-SHA256 Signing** — Optional event signature verification
- **Timing-Safe Comparison** — Prevents timing attacks on signatures
- **Deduplication** — Duplicate events detected by UUID + timestamp

### ✅ Input Validation
- **JSON Schema Validation** — All event fields validated with AJV
- **Type Checking** — Strict type enforcement (no type coercion)
- **Length Limits** — Query parameters bounded (max 200 chars)
- **Path Traversal Prevention** — Session/trace IDs validated against UUID format

### ✅ Rate Limiting
- **Per-Tenant Rate Limiting** — Prevents abuse by single tenant
- **Connection Limits** — Maximum 100 concurrent SSE connections
- **Rejection Logging** — Failed events logged with reasons

### ✅ Transport Security
- **HTTPS Support** — Configured via Docker / reverse proxy
- **CORS Protection** — Dashboard access protected by origin validation (dev mode optional)
- **No Sensitive Data in Logs** — API keys never logged (hashed only)

---

## Known Limitations

### Not In Scope
- **TLS/Encryption in Transit** — Deploy behind TLS terminator (nginx, CloudFront, etc.)
- **At-Rest Encryption** — SQLite data not encrypted (handle via disk encryption)
- **Access Control Lists** — No per-resource ACLs (use API keys with different scopes)
- **Audit Trail Immutability** — SQLite can be modified (use backups/archival)

### Secure Defaults
- **Dev Mode** — Dashboard accessible without token (dev convenience only)
- **Admin Token** — Admin endpoints disabled if not configured
- **HMAC Secrets** — Optional (only required for strict event verification)

---

## Dependencies

We track security advisories for all production dependencies:

```json
{
  "ajv": "^8.18.0",                // JSON Schema validation
  "ajv-formats": "^3.0.1",         // Format validation
  "better-sqlite3": "^12.8.0",     // Database driver
  "express": "^5.2.1",             // Web framework
  "pino": "^10.3.1"                // Logging
}
```

**Security Practices:**
- ✅ Dependencies audited with `npm audit`
- ✅ Regular updates for security patches
- ✅ Pinned versions in `package-lock.json`
- ✅ No binary dependencies (except sqlite3)

**How to Check:**
```bash
npm audit                          # List vulnerabilities
npm audit fix                      # Auto-fix patched versions
npm audit --production             # Check production deps only
```

---

## Best Practices for Deploying AEP

### 1. Use TLS/HTTPS
```bash
# Behind nginx reverse proxy with TLS
# or use AWS ELB with HTTPS termination
```

### 2. Set Strong Tokens
```bash
DASHBOARD_TOKEN=$(openssl rand -hex 32)
ADMIN_TOKEN=$(openssl rand -hex 32)
export DASHBOARD_TOKEN ADMIN_TOKEN
```

### 3. Rotate API Keys Regularly
```bash
# Use /admin/keys to revoke old keys
# Rotate every 90 days
```

### 4. Enable HMAC Signing
```bash
# For high-security environments, require event signatures
aep emit --hmac-secret $(openssl rand -hex 32)
```

### 5. Use Database Backups
```bash
# Backup SQLite regularly
sqlite3 data/aep.db ".backup /backups/aep-$(date +%Y%m%d).db"
```

### 6. Monitor Rejection Logs
```bash
# Check for suspicious patterns
curl http://localhost:8787/metrics | grep rejections
```

### 7. Use Network Isolation
```bash
# In Kubernetes: NetworkPolicy
# In Docker: restrict to internal networks only
# In cloud: security groups / VPCs
```

---

## Security Checklist

- [ ] Deploy behind TLS reverse proxy
- [ ] Set strong `DASHBOARD_TOKEN` and `ADMIN_TOKEN`
- [ ] Enable HMAC signing in production
- [ ] Configure rate limiting in reverse proxy
- [ ] Set up database backups
- [ ] Monitor `/metrics` endpoint regularly
- [ ] Run `npm audit` before deployment
- [ ] Restrict API keys to minimum required scopes
- [ ] Use network segmentation (VPC, security groups)
- [ ] Audit access logs periodically

---

## Responsible Disclosure Timeline

Our coordinated disclosure timeline:

| Day | Action |
|-----|--------|
| 0 | Vulnerability reported to us |
| 1 | We acknowledge receipt |
| 7 | We provide initial assessment |
| 14-21 | We develop fix and test |
| 30 | We release patched version |
| 35 | We publish security advisory |

---

## Security Contacts

| Role | Contact |
|------|---------|
| Security Lead | [TODO: name/email] |
| Maintainer | [TODO: name/email] |

---

## References

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [Node.js Security Best Practices](https://nodejs.org/en/docs/guides/security/)
- [Express.js Security Recommendations](https://expressjs.com/en/advanced/best-practices-security.html)
- [SQLite Security](https://www.sqlite.org/security.html)

---

Thank you for helping keep AEP secure! 🔒
