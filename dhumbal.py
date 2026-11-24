"""Play Dhumbal in the terminal (python3 dhumbal.py) or in a window (python3 dhumbal.py --gui)."""
import sys

if __name__ == "__main__":
    if "--gui" in sys.argv[1:]:
        from gui import main
    else:
        from cli import main
    main()
