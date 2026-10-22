"""Thorfinn - Abuja public transport journey planner.

This package contains the FastAPI application. The important modules are:

- config.py     -> reads settings from the .env file
- database.py   -> creates the database engine and sessions
- models.py     -> the database tables (stops, links, suggestions, ...)
- security.py   -> password hashing, sessions, CSRF protection
- main.py       -> builds the FastAPI app and wires everything together
- routes/       -> the HTTP endpoints (URLs), split by area
"""
