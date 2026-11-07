//! The hub's TCP listener, counting what each connection reads: the node link times its silence by bytes arriving,
//! not whole frames, so one large frame coming in slowly (a 25 MiB put_file over 1 Mbit/s) never looks like a dead
//! link. Nagle is off on every connection, as on the node's end of its link.
use axum::extract::connect_info::Connected;
use axum::serve::{IncomingStream, Listener};
use std::io;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::task::{Context, Poll};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::{TcpListener, TcpStream};

pub struct Counted(pub TcpListener);

/// One connection's bytes read so far.
pub type ReadCount = Arc<AtomicU64>;

pub struct CountedStream {
    inner: TcpStream,
    read: ReadCount,
}

impl Listener for Counted {
    type Io = CountedStream;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        let (inner, addr) = Listener::accept(&mut self.0).await;
        // Small frames that answer each other (a screen's start, its control, its first frame; the app's calls) would
        // each wait out a delayed ack.
        let _ = inner.set_nodelay(true);
        let read = ReadCount::default();
        (CountedStream { inner, read }, addr)
    }

    fn local_addr(&self) -> io::Result<Self::Addr> {
        self.0.local_addr()
    }
}

/// Who connected, and the count of what its connection read so far.
#[derive(Clone, Debug)]
pub struct Peer {
    pub addr: SocketAddr,
    pub read: ReadCount,
}

impl Connected<IncomingStream<'_, Counted>> for Peer {
    fn connect_info(stream: IncomingStream<'_, Counted>) -> Self {
        Peer {
            addr: *stream.remote_addr(),
            read: stream.io().read.clone(),
        }
    }
}

impl AsyncRead for CountedStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let before = buf.filled().len();
        let polled = Pin::new(&mut self.inner).poll_read(cx, buf);
        let read = (buf.filled().len() - before) as u64;
        if read > 0 {
            self.read.fetch_add(read, Ordering::Relaxed);
        }
        polled
    }
}

impl AsyncWrite for CountedStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(cx, buf)
    }

    fn poll_write_vectored(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write_vectored(cx, bufs)
    }

    fn is_write_vectored(&self) -> bool {
        self.inner.is_write_vectored()
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}
