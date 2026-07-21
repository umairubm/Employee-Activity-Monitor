from PIL import Image

from agent.screenshot import compress_image_to_jpeg_bytes


def test_compress_image_to_jpeg_bytes_reduces_size() -> None:
    img = Image.new("RGB", (2000, 1200), color=(255, 255, 255))
    for x in range(0, 2000, 50):
        for y in range(0, 1200, 50):
            img.putpixel((x, y), (0, 0, 0))

    data = compress_image_to_jpeg_bytes(img, quality=70, max_dimension=800)

    assert data.startswith(b"\xff\xd8\xff")
    assert len(data) < 20000
