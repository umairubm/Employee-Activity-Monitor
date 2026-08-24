import fitz
from pathlib import Path
src = Path('attached_assets/Workforce_Bugs_Sheet_-_Sheet1_1787554064114.pdf')
out = Path('.agents/outputs/bugs-pdf')
doc = fitz.open(src)
print('pages', doc.page_count)
for i, page in enumerate(doc):
    pix = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
    target = out / f'page-{i+1}.png'
    pix.save(target)
    print(target)
