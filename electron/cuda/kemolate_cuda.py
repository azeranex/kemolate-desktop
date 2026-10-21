"""
Kemolate's CUDA process: ONNX models on an NVIDIA GPU, for the desktop app.

Opt-in, and only ever started by the app (`electron/cuda.ts`), with a Python the
reader chose — one that has `onnxruntime-gpu` and `numpy`. It is a separate
process because CUDA cannot be reached from the app's window: the window's
models run on WebGPU (or WebAssembly) inside Chromium, and onnxruntime's CUDA
backend exists only as a native library, which this Python already has.

It talks over its own stdin and stdout, never a port: nothing else on the
machine can reach it, and it ends when the app closes the pipe. Each message,
either way, is a frame:

    u32 little-endian  length of the header
    header             UTF-8 JSON
    u32 little-endian  length of the body
    body               raw tensor bytes, laid end to end as the header says

Requests carry an `id`, answered in the same frame shape with `ok` or `error`.
They are handled one at a time, which is how a GPU takes them anyway.

- `hello`: what is here — versions, the device, whether CUDA really opens.
- `open`: a model file as a CUDA session. A session onnxruntime quietly put on
  the CPU instead is refused, because the reader asked for the GPU and a slower
  answer under its name would be a lie (see `preload_dlls` below for the usual
  reason it happens).
- `run`: one pass of an opened session — the comic detector's whole job.
- `read`: Kemolate OCR's reading of a batch of crops, the encoder and the
  greedy decode together. Done here rather than step by step from the app,
  because each step from the app would carry the encoder's states (about 5 MB
  for a batch of eight) and the logits across the pipe twenty times over. The
  decode is `readBatch`'s in `app/utils/ocr/manga.ts`, rule for rule: start
  token, end token, the token limit, the first of equal scores, and a row taken
  out of the batch once it has ended. Change one, change the other.

Stdout carries frames and nothing else; anything said goes to stderr.
"""

import json
import struct
import sys
import time

DTYPES = {
    'float32': 'float32',
    'float16': 'float16',
    'int64': 'int64',
    'int32': 'int32',
    'uint8': 'uint8',
    'int8': 'int8',
    'bool': 'bool',
}

out = sys.stdout.buffer
src = sys.stdin.buffer


def say(*parts):
    print('[kemolate-cuda]', *parts, file=sys.stderr, flush=True)


def read_exact(count):
    data = bytearray()
    while len(data) < count:
        chunk = src.read(count - len(data))
        if not chunk:
            return None
        data.extend(chunk)
    return bytes(data)


def receive():
    head = read_exact(4)
    if head is None:
        return None, None
    header = json.loads(read_exact(struct.unpack('<I', head)[0]).decode('utf-8'))
    body = read_exact(struct.unpack('<I', read_exact(4))[0])
    return header, body


def send(header, body=b''):
    data = json.dumps(header).encode('utf-8')
    out.write(struct.pack('<I', len(data)) + data + struct.pack('<I', len(body)))
    if body:
        out.write(body)
    out.flush()


try:
    import numpy as np
    import onnxruntime as ort
except ImportError as error:
    # Said in the hello rather than by dying: the app shows it to the reader,
    # who chose this Python and can choose another.
    np = None
    ort = None
    missing = str(error)
else:
    missing = None
    # CUDA's and cuDNN's DLLs, from wherever this Python keeps them (the
    # `nvidia-*` wheels, or torch's). Without this a session asked for CUDA
    # opens on the CPU and says nothing, which measured exactly like the CPU.
    try:
        ort.preload_dlls()
    except Exception as error:  # noqa: BLE001 — older builds have no preload; the session check below decides.
        say('preload_dlls:', error)
    ort.set_default_logger_severity(3)

sessions = {}


def tensors(spec, body):
    feeds = {}
    for name, item in spec.items():
        start, length = item['offset'], item['length']
        array = np.frombuffer(body, dtype=DTYPES[item['dtype']], count=length // np.dtype(DTYPES[item['dtype']]).itemsize, offset=start)
        feeds[name] = array.reshape(item['dims'])
    return feeds


def pack(named):
    spec, parts, at = {}, [], 0
    for name, array in named.items():
        array = np.ascontiguousarray(array)
        data = array.tobytes()
        spec[name] = {'dtype': str(array.dtype), 'dims': list(array.shape), 'offset': at, 'length': len(data)}
        parts.append(data)
        at += len(data)
    return spec, b''.join(parts)


def hello(_header, _body):
    if missing:
        return {'ready': False, 'error': f'This Python has no {missing.split()[-1] if missing else "onnxruntime"}: {missing}. It needs onnxruntime-gpu and numpy.'}, b''
    providers = ort.get_available_providers()
    answer = {'python': sys.version.split()[0], 'onnxruntime': ort.__version__, 'providers': providers, 'ready': 'CUDAExecutionProvider' in providers}
    if not answer['ready']:
        answer['error'] = 'This Python’s onnxruntime has no CUDA backend — it needs onnxruntime-gpu.'
        return answer, b''
    # A real session, the smallest there is, so "ready" means CUDA opened rather than that it is listed.
    try:
        from onnx import TensorProto, helper  # noqa: PLC0415 — only for this check, and optional
        graph = helper.make_graph([helper.make_node('Identity', ['x'], ['y'])], 'probe',
                                  [helper.make_tensor_value_info('x', TensorProto.FLOAT, [1])],
                                  [helper.make_tensor_value_info('y', TensorProto.FLOAT, [1])])
        # IR 9 and opset 17: old enough for any onnxruntime-gpu this is likely to meet —
        # `onnx` stamps its own newest IR otherwise, which a slightly older runtime refuses.
        model = helper.make_model(graph, opset_imports=[helper.make_opsetid('', 17)], ir_version=9)
        probe = ort.InferenceSession(model.SerializeToString(), providers=['CUDAExecutionProvider'])
        answer['ready'] = probe.get_providers()[0] == 'CUDAExecutionProvider'
        if not answer['ready']:
            answer['error'] = 'CUDA is listed but would not open — its DLLs (CUDA, cuDNN) are not where this Python can load them.'
    except ImportError:
        pass
    # The device's name, for Settings' Test only: torch is the one library here that
    # knows it, and importing it costs seconds a reading should not wait for.
    if not _header.get('detail'):
        return answer, b''
    try:
        import torch  # noqa: PLC0415 — only to name the device, and optional
        if torch.cuda.is_available():
            answer['device'] = torch.cuda.get_device_name(0)
    except Exception:  # noqa: BLE001
        pass
    return answer, b''


def open_session(header, _body):
    path = header['path']
    if path in sessions:
        session = sessions[path]
    else:
        started = time.perf_counter()
        session = ort.InferenceSession(path, providers=['CUDAExecutionProvider', 'CPUExecutionProvider'])
        if session.get_providers()[0] != 'CUDAExecutionProvider':
            raise RuntimeError('onnxruntime would not open this model on CUDA — its DLLs (CUDA, cuDNN) are not where this Python can load them.')
        sessions[path] = session
        say('opened', path, f'{(time.perf_counter() - started) * 1000:.0f} ms')
    return {'inputs': [i.name for i in session.get_inputs()], 'outputs': [o.name for o in session.get_outputs()]}, b''


def run(header, body):
    session = sessions[header['path']]
    outputs = session.run(None, tensors(header['feeds'], body))
    spec, data = pack(dict(zip([o.name for o in session.get_outputs()], outputs)))
    return {'outputs': spec}, data


def read(header, body):
    """`readBatch`, here — see the module's note."""
    encoder = sessions[header['encoder']]
    decoder = sessions[header['decoder']]
    count, edge = header['count'], header['edge']
    start, end, limit = header['start'], header['end'], header['limit']

    pixels = np.frombuffer(body, dtype=np.float32, count=count * 3 * edge * edge).reshape(count, 3, edge, edge)
    hidden = encoder.run(None, {'pixel_values': pixels})[0]

    tokens = [[start] for _ in range(count)]
    playing = list(range(count))
    states = hidden

    for step in range(limit):
        if not playing:
            break
        said = step + 1
        ids = np.array([tokens[index] for index in playing], dtype=np.int64).reshape(len(playing), said)
        logits = decoder.run(None, {'input_ids': ids, 'encoder_hidden_states': states})[0]
        # Each row's next token off its last position; argmax takes the first of equals, as `bestId` does.
        best = np.argmax(logits[:, -1, :], axis=-1)
        for at, index in enumerate(playing):
            tokens[index].append(int(best[at]))
        still = [index for index in playing if tokens[index][-1] != end]
        if len(still) < len(playing):
            playing = still
            states = hidden[still] if still else hidden[:0]

    return {'tokens': tokens}, b''


HANDLERS = {'hello': hello, 'open': open_session, 'run': run, 'read': read}


def main():
    say('ready, waiting for the app')
    while True:
        header, body = receive()
        if header is None:
            return
        handler = HANDLERS.get(header.get('op'))
        try:
            if handler is None:
                raise ValueError(f'unknown op {header.get("op")!r}')
            if ort is None and header.get('op') != 'hello':
                raise RuntimeError(f'onnxruntime is missing: {missing}')
            answer, data = handler(header, body)
            send({'id': header.get('id'), 'ok': True, **answer}, data)
        except Exception as error:  # noqa: BLE001 — every failure goes back to the app as words
            send({'id': header.get('id'), 'ok': False, 'error': str(error)})


if __name__ == '__main__':
    main()
