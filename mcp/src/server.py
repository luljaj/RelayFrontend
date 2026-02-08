import asyncio
import os

from dedalus_mcp import MCPServer
from dotenv import load_dotenv

from src.tools import check_status, post_status

load_dotenv()

server = MCPServer("relay-mcp")

server.collect(check_status, post_status)


async def run_server() -> None:
    await server.serve(
        host="0.0.0.0",
        path="/mcp",
        log_level=os.getenv("LOG_LEVEL", "info").lower(),
    )


if __name__ == "__main__":
    asyncio.run(run_server())
