"""
ObligoTrack - Backend Middleware Package
Exports all middleware components for use in main.py
"""

from .auth_middleware import AuthMiddleware, get_current_user, require_roles
from .tenant_middleware import TenantMiddleware, get_current_company
from .audit_middleware import AuditMiddleware
from .rate_limit_middleware import RateLimitMiddleware
from .logging_middleware import LoggingMiddleware

__all__ = [
    # Auth & RBAC
    "AuthMiddleware",
    "get_current_user",
    "require_roles",

    # Multi-tenant isolation
    "TenantMiddleware",
    "get_current_company",

    # Audit trail
    "AuditMiddleware",

    # Rate limiting
    "RateLimitMiddleware",

    # Request logging
    "LoggingMiddleware",
]
