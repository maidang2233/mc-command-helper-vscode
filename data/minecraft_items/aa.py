import os
import re

folder_path = "."  # 目标文件夹路径

for filename in os.listdir(folder_path):
    # 去掉JE后跟任意数字的部分
    new_filename = re.sub(r"_BE\d+", "", filename)
    if new_filename != filename:  # 仅当文件名有修改时执行重命名
        old_path = os.path.join(folder_path, filename)
        new_path = os.path.join(folder_path, new_filename)
        os.rename(old_path, new_path)
        print(f"去掉JE+数字：{filename} → {new_filename}")