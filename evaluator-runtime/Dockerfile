# Môi trường chạy bộ chấm Python của admin (ADR-048). Mỗi lượt chấm là một container mới từ image này
# với `--network none --read-only`: image chỉ chứa thư viện, không chứa dữ liệu và không chứa secret.
#
# Thư viện ghim cứng: đổi bất kỳ dòng nào là đổi môi trường chấm, nên phải build lại với tag mới
# (`vku-evaluator-runtime:<N>`) - đó là cách các cấu hình đã xác minh trước đó tự mất hiệu lực.
FROM python:3.12-slim

RUN pip install --no-cache-dir \
      "numpy==2.3.3" \
      "pandas==2.3.3" \
      "scipy==1.16.2" \
      "scikit-learn==1.7.2"

COPY entrypoint.py /opt/evaluator/entrypoint.py

WORKDIR /tmp
USER 65534:65534
ENTRYPOINT ["python", "/opt/evaluator/entrypoint.py"]
