import os
import re

# 替换为你的文件所在目录路径
target_dir = "D:\\我的世界相关\\整合HTML\\titleraw_防熊\\新建文件夹 (2)"

# 遍历目录下所有文件
for filename in os.listdir(target_dir):
    file_path = os.path.join(target_dir, filename)
    # 仅处理文件（跳过子目录）
    if os.path.isfile(file_path):
        # 正则匹配"jex+任意数字"（不区分大小写可加 re.IGNORECASE）
        new_filename = re.sub(r'_Axis_Y', '', filename)
        # 只有文件名发生变化时才执行重命名
        if new_filename != filename:
            new_file_path = os.path.join(target_dir, new_filename)
            os.rename(file_path, new_file_path)
            print(f"已重命名：{filename} -> {new_filename}")

print("所有文件处理完成")