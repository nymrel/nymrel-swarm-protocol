from pathlib import Path

from setuptools import find_packages, setup

ROOT = Path(__file__).resolve().parent

setup(
    name="nymrel-swarm-protocol",
    version="1.0.0",
    description="Zero-dependency Multi-Agent Swarm Protocol, Two-Seat Command Studio Contract, and File-Based Bus Engine.",
    long_description=(ROOT / "README.md").read_text(encoding="utf-8"),
    long_description_content_type="text/markdown",
    author="Nymrel",
    author_email="contact@nymrel.com",
    url="https://github.com/nymrel/nymrel-swarm-protocol",
    package_dir={"": "python"},
    packages=find_packages(where="python"),
    python_requires=">=3.9",
    install_requires=[],
    entry_points={
        "console_scripts": [
            "swarm-protocol-py=nymrel_swarm_protocol.cli:main",
        ],
    },
    classifiers=[
        "License :: OSI Approved :: MIT License",
        "Programming Language :: Python :: 3",
        "Operating System :: OS Independent",
    ],
)
