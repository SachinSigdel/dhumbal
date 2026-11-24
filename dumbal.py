"""Play Dumbal in the terminal (python3 dumbal.py) or in a window (python3 dumbal.py --gui)."""
import sys

if __name__ == "__main__":
    if "--gui" in sys.argv[1:]:
        from gui import main
    else:
        from cli import main
    main()
