import tkinter as tk
root = tk.Tk()
lbl = tk.Label(root, text="Click Me", bg="blue", fg="white", state="normal")
lbl.pack(padx=50, pady=50)

def onclick(e):
    print("Clicked!")
    root.destroy()

lbl.bind("<Button-1>", onclick)
root.after(2000, lambda: print("Timeout") or root.destroy())
root.mainloop()
