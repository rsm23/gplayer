CREATE TABLE `tb_settings` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `key` varchar(150) COLLATE latin1_swedish_ci NOT NULL,
  `value` mediumtext COLLATE latin1_swedish_ci NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

INSERT INTO `tb_settings` (`id`, `key`, `value`) VALUES
  (1, 'updated', '84'),
  (2, 'updated', '83'),
  (3, 'jwplayer-license', 'legacy-key'),
  (4, 'custom-hostnames', 'obsolete');

CREATE TABLE `tb_users` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `user` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `email` varchar(254) COLLATE utf8mb4_unicode_ci NOT NULL,
  `password` varchar(500) COLLATE utf8mb4_unicode_ci NOT NULL,
  `name` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `status` tinyint(1) unsigned NOT NULL DEFAULT '1',
  `created` int(10) unsigned NOT NULL DEFAULT '0',
  `updated` int(10) unsigned NOT NULL DEFAULT '0',
  `role` tinyint(1) unsigned NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `tb_users` (`id`, `user`, `email`, `password`, `name`) VALUES
  (7, 'owner', 'owner@example.test', 'not-a-production-password', 'Owner');

CREATE TABLE `tb_videos` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `title` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `host` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `host_id` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `uid` int(10) unsigned NOT NULL,
  `created` int(10) unsigned NOT NULL DEFAULT '0',
  `updated` int(10) unsigned NOT NULL DEFAULT '0',
  `poster` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `status` tinyint(1) unsigned NOT NULL DEFAULT '1',
  `views` int(10) unsigned NOT NULL DEFAULT '0',
  `dmca` tinyint(1) unsigned NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `tb_videos` (`id`, `title`, `host`, `host_id`, `uid`, `poster`) VALUES
  (11, REPEAT('T', 300), 'vidhide', REPEAT('h', 2200), 7, REPEAT('p', 2200)),
  (12, 'Orphan', 'goodstream1', 'orphan-id', 999, '');

CREATE TABLE `tb_videos_short` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `vid` bigint(20) unsigned NOT NULL,
  `key` varchar(150) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `tb_videos_short` (`vid`, `key`) VALUES (11, 'legacy-slug');

CREATE TABLE `tb_stats_ua` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `ua` varchar(500) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `tb_stats_ua` (`id`, `ua`) VALUES
  (1, 'Existing Browser'),
  (2, 'Existing Browser'),
  (3, REPEAT('L', 300));

CREATE TABLE `tb_stats` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `vid` bigint(20) unsigned NOT NULL,
  `ip` varchar(45) COLLATE utf8mb4_unicode_ci NOT NULL,
  `ua` varchar(500) COLLATE utf8mb4_unicode_ci NOT NULL,
  `created` int(10) unsigned NOT NULL DEFAULT '0',
  `asn` int(10) unsigned DEFAULT NULL,
  `country` char(5) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `tb_stats` (`id`, `vid`, `ip`, `ua`) VALUES
  (1, 11, '198.51.100.1', 'Legacy Browser'),
  (2, 11, '198.51.100.2', ''),
  (3, 11, '198.51.100.3', 'Legacy Browser');

CREATE TABLE `tb_videos_hash` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `host` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `host_id` varchar(2048) COLLATE utf8mb4_unicode_ci NOT NULL,
  `gdrive_email` varchar(254) COLLATE utf8mb4_unicode_ci NOT NULL,
  `data` longtext COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `tb_videos_hash` (`host`, `host_id`, `gdrive_email`, `data`) VALUES
  ('drive', 'one', 'owner@example.test', NULL),
  ('drive', 'two', 'owner@example.test', '{}');

CREATE TABLE `tb_maxmind_asn` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `tb_maxmind` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `ip` varchar(45) COLLATE utf8mb4_unicode_ci NOT NULL,
  `prefix_len` tinyint(3) unsigned DEFAULT NULL,
  `asn` int(10) unsigned DEFAULT NULL,
  `continent` char(2) COLLATE utf8mb4_unicode_ci NOT NULL,
  `country` varchar(5) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `tb_maxmind` (`ip`, `prefix_len`, `continent`, `country`) VALUES
  ('198.51.100.0', 24, 'EU', 'FR'),
  ('198.51.100.0', 24, 'EU', 'FR');

CREATE TABLE `tb_gdrive_auth` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `email` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `api_key` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `client_id` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `client_secret` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `refresh_token` varchar(150) COLLATE utf8mb4_unicode_ci NOT NULL,
  `created` int(10) unsigned NOT NULL DEFAULT '0',
  `status` tinyint(1) unsigned NOT NULL DEFAULT '0',
  `bypass` tinyint(1) unsigned NOT NULL DEFAULT '0',
  `updated` int(10) unsigned NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `tb_gdrive_auth` (`email`, `api_key`, `client_id`, `client_secret`, `refresh_token`) VALUES
  ('drive@example.test', '', '', '', '');

CREATE TABLE `tb_gdrive_duplicate` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `gdrive_id` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `gdrive_email` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `title` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `fileSize` bigint(20) unsigned NOT NULL DEFAULT '0',
  `md5Checksum` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL,
  `sha1Checksum` varchar(40) COLLATE utf8mb4_unicode_ci NOT NULL,
  `sha256Checksum` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `description` text COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `tb_gdrive_duplicate` (`gdrive_id`, `gdrive_email`, `title`, `description`, `md5Checksum`, `sha1Checksum`, `sha256Checksum`) VALUES
  ('valid', 'drive@example.test', 'Valid', '', '', '', ''),
  ('orphan', 'missing@example.test', 'Orphan', '', '', '', '');

CREATE TABLE `tb_gdrive_mirrors` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `gdrive_id` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `mirror_id` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `mirror_email` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `created` int(10) unsigned NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `tb_gdrive_mirrors` (`gdrive_id`, `mirror_id`, `mirror_email`) VALUES
  ('source', 'valid', 'drive@example.test'),
  ('source', 'orphan', 'missing@example.test');

CREATE TABLE `tb_sessions` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `ip` varchar(45) COLLATE utf8mb4_unicode_ci NOT NULL,
  `useragent` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `created` int(10) unsigned NOT NULL DEFAULT '0',
  `username` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `token` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `stat` int(10) unsigned NOT NULL DEFAULT '9',
  `expires` int(10) unsigned NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `tb_sessions` (`ip`, `useragent`, `username`, `token`) VALUES
  ('198.51.100.1', 'Browser', 'owner', 'valid'),
  ('198.51.100.2', 'Browser', 'missing', 'orphan');

CREATE TABLE `tb_subtitle_manager` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `file_name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `file_size` int(10) unsigned NOT NULL DEFAULT '0',
  `file_type` varchar(25) COLLATE utf8mb4_unicode_ci NOT NULL,
  `language` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `created` int(10) unsigned NOT NULL DEFAULT '0',
  `uid` int(10) unsigned NOT NULL,
  `host` varchar(263) COLLATE utf8mb4_unicode_ci NOT NULL,
  `updated` int(10) unsigned NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `tb_subtitle_manager` (`file_name`, `file_type`, `language`, `uid`, `host`) VALUES
  ('valid.vtt', 'text/vtt', 'English', 7, 'https://example.test/'),
  ('orphan.vtt', 'text/vtt', 'English', 999, 'https://example.test/');

CREATE TABLE `tb_subtitles` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `language` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `link` varchar(2048) COLLATE utf8mb4_unicode_ci NOT NULL,
  `vid` bigint(20) unsigned NOT NULL,
  `created` int(10) unsigned NOT NULL DEFAULT '0',
  `uid` int(10) unsigned NOT NULL,
  `order` tinyint(3) unsigned NOT NULL DEFAULT '0',
  `updated` int(10) unsigned NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `tb_subtitles` (`language`, `link`, `vid`, `uid`) VALUES
  ('English', 'https://example.test/valid.vtt', 11, 7),
  ('English', 'https://example.test/orphan-user.vtt', 11, 999),
  ('English', 'https://example.test/orphan-video.vtt', 999, 7),
  ('English', 'https://example.test/deleted-parent.vtt', 12, 7);

CREATE TABLE `tb_videos_alternatives` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `vid` bigint(20) unsigned NOT NULL,
  `host` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `host_id` varchar(2048) COLLATE utf8mb4_unicode_ci NOT NULL,
  `order` tinyint(3) unsigned NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `tb_videos_alternatives` (`vid`, `host`, `host_id`) VALUES
  (11, 'direct', 'https://example.test/video.mp4'),
  (999, 'direct', 'https://example.test/orphan.mp4');
