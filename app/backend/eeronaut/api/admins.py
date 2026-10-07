"""Who else can administer this network.

eero calls these members and invites. An owner creates an invite, gets a URL
back, and sends it to somebody however they like — there is no email field
anywhere in this flow, because eero's own API does not take one:
`CreateInviteRequest` carries a role and nothing else. So the honest shape is
create, copy, share, and watch it sit pending until they accept.

Admin only. `Invite.Role` also accepts `owner`, which transfers the network
rather than adding a helper, and the eero app does not offer it from this
screen either. Handing away ownership is a different action and does not
belong behind the same button.

Endpoints, from `INetworkService`:

    GET    2.2/networks/{id}/invites
    POST   2.2/networks/{id}/invites                  {role}
    DELETE 2.2/networks/{id}/invites/{inviteId}
    POST   2.2/networks/{id}/invites/cancel_pending_admin
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from ..clients.cloud import EeroCloud
from .deps import authed_cloud, current_network
from ..core.errors import UpstreamError

router = APIRouter(prefix="/api/network/admins", tags=["admins"])

Json = dict


def _invite(row: Json) -> Json:
    """One pending or expired invite.

    `invite_url` is what somebody actually needs; the rest is for showing why
    an invite is no longer any use.
    """
    return {
        "id": row.get("invite_id"),
        "nickname": row.get("invite_nickname"),
        "role": row.get("invite_role"),
        "status": (row.get("invite_status") or "").lower(),
        "expires_at": row.get("invite_expiration_date"),
        "expires_in_s": row.get("invite_expiration_in_sec"),
        "url": row.get("invite_url"),
    }


@router.get("/invites")
async def list_invites(c: EeroCloud = Depends(authed_cloud),
                       net: str = Depends(current_network)) -> Json:
    """Outstanding invites.

    Members are read by `GET /api/members`, which already works out which one
    is you from eero's `is_me` user tag. An invite nobody has accepted is a
    different thing from a member: it is access that has been offered and not
    taken, and it is worth showing separately rather than folded in as a
    half-member.
    """
    try:
        rows = await c.get(f"{net.rstrip('/')}/invites")
    except UpstreamError:
        # Other collections in this API answer 404 rather than an empty list
        # when there is nothing, so an absent list is not a failure.
        rows = []
    return {"invites": [_invite(r) for r in (rows or []) if isinstance(r, dict)]}


@router.post("/invites")
async def create_invite(c: EeroCloud = Depends(authed_cloud),
                        net: str = Depends(current_network)) -> Json:
    """Make an admin invite and hand back its link.

    No body from the caller: the role is not theirs to choose. `owner` is a
    valid value on eero's side and is deliberately not reachable from here.

    The field is `invite_role`, not `role`. eero rejects the request without
    it, which is what made "Invite an admin" fail every time it was pressed —
    the name comes from the phone app, whose own constant for this key reads
    `DATA_KEY_INVITE_ROLE = "invite_role"`, and whose Role enum serializes
    admin as "admin". Everything else about the request was already right.
    """
    got = await c.post(f"{net.rstrip('/')}/invites",
                       json={"invite_role": "admin"})
    out = _invite({**(got or {}), "invite_status": "pending"})
    if not out.get("url"):
        # Without the URL there is nothing to send anybody, so this is a
        # failure even though eero answered.
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="eero created the invite but did not return a link for it.")
    return out


@router.delete("/invites/{invite_id}")
async def cancel_invite(invite_id: str,
                        c: EeroCloud = Depends(authed_cloud),
                        net: str = Depends(current_network)) -> Json:
    """Withdraw one invite. The link stops working."""
    await c.delete(f"{net.rstrip('/')}/invites/{invite_id}")
    return {"canceled": invite_id}


@router.post("/invites/cancel-pending")
async def cancel_pending(c: EeroCloud = Depends(authed_cloud),
                         net: str = Depends(current_network)) -> Json:
    """Withdraw every pending admin invite at once.

    eero has its own endpoint for this rather than requiring a delete each,
    which is worth using: canceling them one at a time leaves a window where
    some links still work.
    """
    await c.post(f"{net.rstrip('/')}/invites/cancel_pending_admin")
    return {"canceled": "pending"}
