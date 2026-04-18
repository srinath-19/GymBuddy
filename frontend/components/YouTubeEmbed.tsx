"use client";

interface YouTubeEmbedProps {
  videoId: string;
  title: string;
}

export default function YouTubeEmbed({ videoId, title }: YouTubeEmbedProps) {
  return (
    <div style={{ position: "relative", width: "100%", aspectRatio: "16/9", borderRadius: "0.5rem", overflow: "hidden" }}>
      <iframe
        src={`https://www.youtube.com/embed/${videoId}`}
        title={title}
        width="100%"
        height="100%"
        style={{ border: "none", display: "block" }}
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowFullScreen
      />
    </div>
  );
}
