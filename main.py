"""Small FastAPI service that asks Gemini to analyze a slow SQL query."""

import logging
import os

from dotenv import load_dotenv
from fastapi import FastAPI
from pydantic import BaseModel, Field

load_dotenv()
logger = logging.getLogger("db_profiler.ai")


class QueryInput(BaseModel):
    sql_query: str = Field(min_length=1, max_length=100_000)
    execution_time_sec: float = Field(ge=0, allow_inf_nan=False)
    table_schema: str = Field(default="", max_length=200_000)


class AnalysisOutput(BaseModel):
    summary: str = Field(min_length=1)
    recommendation: str | list[str]
    optimized_query: str = Field(min_length=1)



app = FastAPI(
    title="Database Profiler AI Service",
    description="Returns structured Gemini analysis for slow PostgreSQL queries.",
    version="1.0.0",
)


@app.get("/", tags=["health"])
async def health() -> dict[str, str | bool]:
    return {
        "status": "ok",
        "service": "Database Profiler AI Service",
        "gemini_configured": bool(os.getenv("GOOGLE_API_KEY", "").strip()),
    }
