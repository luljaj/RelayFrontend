from dataclasses import dataclass


@dataclass
class AuthenticatedUser:
    login: str
    name: str = "Unknown"
    email: str = "unknown@example.com"


def get_user_from_username(username: str) -> AuthenticatedUser:
    """
    Simple user object from username.
    In production, this would integrate with Dedalus OAuth when available.
    """
    return AuthenticatedUser(login=username)
